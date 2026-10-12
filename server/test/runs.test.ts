import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AiSession } from '@noteviewer/shared';
import { VaultIndex } from '../src/vault/indexer.js';
import { VaultBus } from '../src/vault/watcher.js';
import { ShareStore } from '../src/share/store.js';
import { SessionStore } from '../src/ai/sessions.js';
import { NotConfiguredError, RunBusyError, RunManager } from '../src/ai/runs.js';
import { deferred, fakeClient, msg, type Script } from './fake-anthropic.js';
import { makeVault } from './helpers.js';

const config = { model: 'claude-opus-5-5', effort: 'high' as const, maxRounds: 10, fallbacks: true };

async function setup(script: Script, files: Record<string, string> = {}, dataDir: string | null = null) {
  const vaultRoot = await makeVault(files);
  const index = new VaultIndex(vaultRoot);
  await index.init();
  const ctx = { vaultRoot, index, bus: new VaultBus(), shares: await ShareStore.open() };
  const store = await SessionStore.open(dataDir);
  const { client, calls } = fakeClient(script);
  const runs = new RunManager({ store, client, config, ctx });
  const session = await store.create({ model: config.model, system: 'SYS' });
  return { runs, store, session, calls, read: (rel: string) => readFile(path.join(vaultRoot, rel), 'utf8') };
}

async function finished(runs: RunManager, id: string) {
  for (let i = 0; i < 200 && runs.isRunning(id); i++) await new Promise((r) => setTimeout(r, 5));
  expect(runs.isRunning(id)).toBe(false);
}

describe('RunManager', () => {
  it('runs a turn to completion and folds it into the session', async () => {
    const s = await setup([msg([{ type: 'text', text: 'Hi there' }])]);
    const turn = s.runs.start(s.session.id, { prompt: 'Hello agent', path: 'a.md' });
    expect(turn.status).toBe('running');
    await finished(s.runs, s.session.id);
    const stored = s.store.get(s.session.id)!;
    expect(stored.title).toBe('Hello agent');
    expect(stored.turns[0]).toMatchObject({ status: 'done', items: [{ kind: 'text', text: 'Hi there' }] });
    expect(stored.usage.inputTokens).toBe(10);
    expect(stored.messages[0]).toMatchObject({ role: 'user' });
    expect(String(stored.messages[0]!.content)).toContain('Open note: a.md');
    expect(stored.messages).toHaveLength(2);
  });

  it('runs with the model and effort chosen for the turn and records them', async () => {
    const s = await setup([msg([{ type: 'text', text: 'a' }]), msg([{ type: 'text', text: 'b' }])]);
    s.runs.start(s.session.id, { prompt: 'one', model: 'claude-haiku-5-5', effort: 'low' });
    await finished(s.runs, s.session.id);
    s.runs.start(s.session.id, { prompt: 'two' });
    await finished(s.runs, s.session.id);
    expect(s.calls[0]).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' } });
    expect(s.calls[1]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'high' } });
    const turns = s.store.get(s.session.id)!.turns;
    expect(turns.map((t) => [t.model, t.effort])).toEqual([['claude-haiku-5-5', 'low'], ['claude-opus-5-5', 'high']]);
  });

  it('refuses a second run while one is active', async () => {
    const gate = deferred();
    const s = await setup([{ message: msg([{ type: 'text', text: 'x' }]), wait: gate.promise }]);
    s.runs.start(s.session.id, { prompt: 'one' });
    expect(() => s.runs.start(s.session.id, { prompt: 'two' })).toThrow(RunBusyError);
    gate.resolve();
    await finished(s.runs, s.session.id);
  });

  it('refuses to run without a client', async () => {
    const s = await setup([]);
    const runs = new RunManager({ store: s.store, client: null, config, ctx: (s.runs as unknown as { d: { ctx: never } }).d.ctx });
    expect(() => runs.start(s.session.id, { prompt: 'x' })).toThrow(NotConfiguredError);
  });

  it('late subscriber gets snapshot with the text so far, then live events', async () => {
    const gate = deferred();
    const s = await setup([{ message: msg([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]), wait: gate.promise }]);
    s.runs.start(s.session.id, { prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    const events: AgentEvent[] = [];
    const off = s.runs.subscribe(s.session.id, (e) => events.push(e));
    expect(events[0]!.type).toBe('snapshot');
    const snap = (events[0] as { session: AiSession }).session;
    expect(snap.running).toBe(true);
    expect(snap.turns[0]!.items).toEqual([{ id: '1.0', kind: 'text', text: 'first' }]);
    gate.resolve();
    await finished(s.runs, s.session.id);
    expect(events).toContainEqual({ type: 'text_delta', turnId: snap.turns[0]!.id, itemId: '1.1', text: 'second' });
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', status: 'done' });
    off();
  });

  it('stops a running turn', async () => {
    const gate = deferred();
    const s = await setup([{ message: msg([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), wait: gate.promise }]);
    s.runs.start(s.session.id, { prompt: 'go' });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.runs.stop(s.session.id)).toBe(true);
    await finished(s.runs, s.session.id);
    expect(s.store.get(s.session.id)!.turns[0]!.status).toBe('stopped');
  });

  it('undoes a turn and blocks undo while running', async () => {
    const s = await setup([
      msg([{ type: 'tool_use', id: 'w', name: 'write', input: { path: 'n.md', content: 'x' } }], 'tool_use'),
      msg([{ type: 'text', text: 'made it' }]),
    ]);
    const turn = s.runs.start(s.session.id, { prompt: 'make a note' });
    await expect(s.runs.undo(s.session.id, turn.id)).rejects.toThrow(RunBusyError);
    await finished(s.runs, s.session.id);
    expect(await s.read('n.md')).toBe('x');
    const results = await s.runs.undo(s.session.id, turn.id);
    expect(results).toEqual([{ id: expect.any(String), status: 'undone' }]);
    await expect(s.read('n.md')).rejects.toThrow();
    expect(s.store.get(s.session.id)!.turns[0]!.changes[0]!.undone).toBe(true);
  });

  it('persists the read ledger so later turns can edit what earlier turns read', async () => {
    const s = await setup(
      [
        msg([{ type: 'tool_use', id: 'r', name: 'read', input: { path: 'a.md' } }], 'tool_use'),
        msg([{ type: 'text', text: 'read it' }]),
        msg([{ type: 'tool_use', id: 'e', name: 'edit', input: { path: 'a.md', old_string: 'x', new_string: 'y' } }], 'tool_use'),
        msg([{ type: 'text', text: 'edited' }]),
      ],
      { 'a.md': 'x' },
    );
    s.runs.start(s.session.id, { prompt: 'read' });
    await finished(s.runs, s.session.id);
    s.runs.start(s.session.id, { prompt: 'edit' });
    await finished(s.runs, s.session.id);
    expect(await s.read('a.md')).toBe('y');
  });

  it('shutdown stops runs and writes the session to disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'noteviewer-runs-'));
    const gate = deferred();
    const s = await setup([{ message: msg([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), wait: gate.promise }], {}, dir);
    s.runs.start(s.session.id, { prompt: 'go' });
    await new Promise((r) => setTimeout(r, 10));
    await s.runs.shutdown();
    const reopened = await SessionStore.open(dir);
    expect(reopened.get(s.session.id)!.turns[0]!.status).toBe('stopped');
  });
});
