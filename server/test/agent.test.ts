import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AgentEvent } from '@noteviewer/shared';
import { VaultIndex } from '../src/vault/indexer.js';
import { VaultBus } from '../src/vault/watcher.js';
import { ShareStore } from '../src/share/store.js';
import { VaultTools } from '../src/ai/tools.js';
import { buildParams, runAgent, type AgentConfig } from '../src/ai/agent.js';
import { deferred, fakeClient, msg, type Script } from './fake-anthropic.js';
import { makeVault } from './helpers.js';

const config: AgentConfig = { model: 'claude-opus-5-5', effort: 'high', maxRounds: 5, fallbacks: true };

async function harness(script: Script, files: Record<string, string> = {}, cfg: AgentConfig = config) {
  const vaultRoot = await makeVault(files);
  const index = new VaultIndex(vaultRoot);
  await index.init();
  const tools = new VaultTools({ vaultRoot, index, bus: new VaultBus(), shares: await ShareStore.open() }, {});
  const { client, calls } = fakeClient(script);
  const events: AgentEvent[] = [];
  const messages: BetaMessageParam[] = [{ role: 'user', content: 'do it' }];
  const abort = new AbortController();
  const run = () =>
    runAgent({
      client, config: cfg, system: 'SYS', messages, tools, turnId: 't1', signal: abort.signal,
      emit: (e) => events.push(e),
    });
  return { run, events, messages, calls, abort, read: (rel: string) => readFile(path.join(vaultRoot, rel), 'utf8') };
}

/** every tool_use in the history has a matching tool_result in the next message */
function assertValidHistory(messages: BetaMessageParam[]) {
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
    if (!ids.length) return;
    const next = messages[i + 1];
    expect(next?.role).toBe('user');
    const resultIds = (next!.content as { type: string; tool_use_id?: string }[])
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id);
    expect(resultIds).toEqual(ids);
  });
}

describe('buildParams', () => {
  it('sets the model, betas, thinking, caching, compaction, fallbacks and tools', () => {
    const p = buildParams(config, 'SYS', []) as Record<string, any>;
    expect(p).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      context_management: { edits: [{ type: 'compact_20260112' }] },
      fallbacks: 'default',
    });
    expect(p.betas).toEqual(['compact-2026-01-12', 'server-side-fallback-2026-07-01']);
    const names = p.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['list', 'read', 'search', 'grep', 'links', 'write', 'edit', 'move', 'delete', 'web_search', 'web_fetch']);
    expect(p.tools.at(-2)).toMatchObject({ type: 'web_search_20260209', max_uses: 8 });
  });

  it('omits fallbacks for models without a server-side fallback', () => {
    for (const model of ['claude-haiku-5-5', 'some-future-model']) {
      const p = buildParams({ ...config, model }, 'SYS', []) as Record<string, any>;
      expect(p.fallbacks).toBeUndefined();
      expect(p.betas).toEqual(['compact-2026-01-12']);
    }
    expect((buildParams({ ...config, model: 'claude-sonnet-5-5' }, 'SYS', []) as Record<string, any>).fallbacks).toBe('default');
  });

  it('omits fallbacks when disabled', () => {
    const p = buildParams({ ...config, fallbacks: false }, 'SYS', []) as Record<string, any>;
    expect(p.fallbacks).toBeUndefined();
    expect(p.betas).toEqual(['compact-2026-01-12']);
  });
});

describe('runAgent', () => {
  it('streams a text answer and appends it to the history', async () => {
    const h = await harness([msg([{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'text', text: 'Hello' }])]);
    expect(await h.run()).toEqual({ status: 'done' });
    expect(h.events).toContainEqual({ type: 'thinking_delta', turnId: 't1', itemId: '1.0', text: 'hm' });
    expect(h.events).toContainEqual({ type: 'text_delta', turnId: 't1', itemId: '1.1', text: 'Hello' });
    expect(h.messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'thinking' }, { type: 'text', text: 'Hello' }] });
    expect(h.events.filter((e) => e.type === 'usage').at(-1)).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it('runs a tool and sends its result back', async () => {
    const h = await harness(
      [
        msg([{ type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'a.md' } }], 'tool_use'),
        msg([{ type: 'text', text: 'It says hi' }]),
      ],
      { 'a.md': 'hi' },
    );
    expect((await h.run()).status).toBe('done');
    expect(h.events).toContainEqual({ type: 'tool_start', turnId: 't1', itemId: 't:tu1', name: 'read', input: { path: 'a.md' } });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'tool_end', itemId: 't:tu1', summary: 'Read a.md (1 line)', isError: false }));
    const second = h.calls[1]!.messages as BetaMessageParam[];
    expect(second.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '     1\thi', is_error: false }],
    });
    assertValidHistory(h.messages);
  });

  it('returns all results of parallel tool calls in one user message', async () => {
    const h = await harness(
      [
        msg(
          [
            { type: 'tool_use', id: 'a', name: 'search', input: { query: 'x' } },
            { type: 'tool_use', id: 'b', name: 'list', input: {} },
          ],
          'tool_use',
        ),
        msg([{ type: 'text', text: 'done' }]),
      ],
      { 'x.md': 'x' },
    );
    await h.run();
    const results = (h.calls[1]!.messages as BetaMessageParam[]).at(-1)!.content as { tool_use_id: string }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
  });

  it('emits change records for vault mutations', async () => {
    const h = await harness([
      msg([{ type: 'tool_use', id: 'w', name: 'write', input: { path: 'n.md', content: 'new' } }], 'tool_use'),
      msg([{ type: 'text', text: 'ok' }]),
    ]);
    await h.run();
    expect(await h.read('n.md')).toBe('new');
    const change = h.events.find((e) => e.type === 'change');
    expect(change).toMatchObject({ type: 'change', turnId: 't1', record: { op: 'create', path: 'n.md', id: expect.any(String) } });
  });

  it('passes tool errors back to the model', async () => {
    const h = await harness([
      msg([{ type: 'tool_use', id: 'r', name: 'read', input: { path: '../etc/passwd' } }], 'tool_use'),
      msg([{ type: 'text', text: 'ok' }]),
    ]);
    await h.run();
    const result = ((h.calls[1]!.messages as BetaMessageParam[]).at(-1)!.content as { is_error: boolean }[])[0]!;
    expect(result.is_error).toBe(true);
  });

  it('resumes after pause_turn without adding a user message', async () => {
    const h = await harness([
      msg([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }], 'pause_turn'),
      msg([{ type: 'text', text: 'found' }]),
    ]);
    expect((await h.run()).status).toBe('done');
    const second = h.calls[1]!.messages as BetaMessageParam[];
    expect(second.at(-1)!.role).toBe('assistant');
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'tool_end', summary: 'web_search "q"' }));
  });

  it('drops an unfinished paused turn when the round limit stops the run', async () => {
    const h = await harness(
      [msg([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }], 'pause_turn')],
      {},
      { ...config, maxRounds: 1 },
    );
    expect((await h.run()).status).toBe('error');
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]!.role).toBe('user');
  });

  it('drops an unfinished paused turn when stopped', async () => {
    const gate = deferred();
    const h = await harness([
      msg([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }], 'pause_turn'),
      { message: msg([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), wait: gate.promise },
    ]);
    const p = h.run();
    await new Promise((r) => setTimeout(r, 20));
    h.abort.abort();
    expect((await p).status).toBe('stopped');
    expect(h.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('never runs a tool whose input was cut off by max_tokens', async () => {
    const h = await harness([msg([{ type: 'tool_use', id: 'w', name: 'write', input: { path: 'n.md', content: 'trunc' } }], 'max_tokens')]);
    const res = await h.run();
    expect(res.status).toBe('error');
    await expect(h.read('n.md')).rejects.toThrow();
    assertValidHistory(h.messages);
    expect(h.messages).toHaveLength(1);
  });

  it('reports a refusal without appending the refused turn', async () => {
    const h = await harness([msg([{ type: 'text', text: 'partial' }], 'refusal')]);
    const res = await h.run();
    expect(res).toMatchObject({ status: 'error', error: expect.stringMatching(/declined/) });
    expect(h.messages).toHaveLength(1);
  });

  it('stops cleanly when aborted during streaming', async () => {
    const gate = deferred();
    const h = await harness([{ message: msg([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), wait: gate.promise }]);
    const p = h.run();
    await new Promise((r) => setTimeout(r, 10));
    h.abort.abort();
    expect(await p).toEqual({ status: 'stopped' });
    expect(h.messages).toHaveLength(1);
  });

  it('answers unrun tool calls as interrupted when aborted between tools', async () => {
    const h = await harness(
      [
        msg(
          [
            { type: 'tool_use', id: 'a', name: 'read', input: { path: 'a.md' } },
            { type: 'tool_use', id: 'b', name: 'read', input: { path: 'a.md' } },
          ],
          'tool_use',
        ),
      ],
      { 'a.md': 'x' },
    );
    // abort as soon as the first tool finishes
    const origPush = h.events.push.bind(h.events);
    h.events.push = (...e: AgentEvent[]) => {
      if (e[0]!.type === 'tool_end') h.abort.abort();
      return origPush(...e);
    };
    expect((await h.run()).status).toBe('stopped');
    const results = h.messages.at(-1)!.content as { tool_use_id: string; content: unknown; is_error: boolean }[];
    expect(results[1]).toMatchObject({ tool_use_id: 'b', is_error: true, content: 'Interrupted by the user' });
    assertValidHistory(h.messages);
  });

  it('stops at the round limit with a valid history', async () => {
    const loop = () => msg([{ type: 'tool_use', id: `l${Math.random()}`, name: 'list', input: {} }], 'tool_use');
    const h = await harness([loop(), loop()], {}, { ...config, maxRounds: 2 });
    const res = await h.run();
    expect(res).toMatchObject({ status: 'error', error: expect.stringMatching(/round limit/i) });
    expect(h.calls).toHaveLength(2);
    assertValidHistory(h.messages);
  });

  it('maps API errors to readable messages', async () => {
    const err = new Anthropic.AuthenticationError(401, { error: { message: 'bad key' } }, 'bad key', new Headers());
    const h = await harness([err]);
    expect(await h.run()).toEqual({ status: 'error', error: 'Invalid ANTHROPIC_API_KEY' });
  });

  it('retries a round whose streamed tool input could not be parsed', async () => {
    const h = await harness([new SyntaxError('Unexpected end of JSON input'), msg([{ type: 'text', text: 'ok' }])]);
    expect((await h.run()).status).toBe('done');
    expect(h.calls).toHaveLength(2);
  });

  it('only ever appends to the history', async () => {
    const h = await harness(
      [
        msg([{ type: 'tool_use', id: 'a', name: 'list', input: {} }], 'tool_use'),
        msg([{ type: 'tool_use', id: 'b', name: 'list', input: {} }], 'tool_use'),
        msg([{ type: 'text', text: 'ok' }]),
      ],
    );
    await h.run();
    const [c1, c2, c3] = h.calls.map((c) => c.messages as unknown[]);
    expect(c2!.slice(0, c1!.length)).toEqual(c1);
    expect(c3!.slice(0, c2!.length)).toEqual(c2);
    expect(h.calls.every((c) => JSON.stringify(c.system) === JSON.stringify(h.calls[0]!.system))).toBe(true);
  });
});
