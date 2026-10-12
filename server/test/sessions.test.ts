import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore, repairSession, toPublic, type StoredSession } from '../src/ai/sessions.js';
import { buildSystemPrompt, buildUserText } from '../src/ai/prompt.js';

const tmp = () => mkdtemp(path.join(tmpdir(), 'noteviewer-sessions-'));

describe('SessionStore', () => {
  it('creates, lists newest first and gets sessions', async () => {
    const store = await SessionStore.open(null);
    const a = await store.create({ model: 'm', system: 's' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ model: 'm', system: 's' });
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(store.list().map((s) => s.id)).toEqual([b.id, a.id]);
    expect(store.get(a.id)?.system).toBe('s');
    expect(store.get('../../etc/passwd')).toBeUndefined();
  });

  it('persists across reopen and deletes files', async () => {
    const dir = await tmp();
    const store = await SessionStore.open(dir);
    const s = await store.create({ model: 'm', system: 's' });
    s.title = 'Hello';
    s.messages.push({ role: 'user', content: 'hi' });
    await store.save(s);
    const reopened = await SessionStore.open(dir);
    expect(reopened.get(s.id)).toMatchObject({ title: 'Hello', messages: [{ role: 'user', content: 'hi' }] });
    expect(await reopened.delete(s.id)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps the latest state when saves overlap', async () => {
    const dir = await tmp();
    const store = await SessionStore.open(dir);
    const s = await store.create({ model: 'm', system: 's' });
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      s.title = `t${i}`;
      saves.push(store.save(s));
    }
    await Promise.all(saves);
    expect((await SessionStore.open(dir)).get(s.id)?.title).toBe('t19');
  });

  it('skips corrupt files', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'AAAAAAAAAAAAAAAA.json'), '{nope');
    const store = await SessionStore.open(dir);
    expect(store.list()).toEqual([]);
  });

  it('repairs a session interrupted mid-run on reopen', async () => {
    const dir = await tmp();
    const store = await SessionStore.open(dir);
    const s = await store.create({ model: 'm', system: 's' });
    s.messages.push(
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'a.md' } }] },
    );
    s.turns.push({ id: 't1', prompt: 'go', context: {}, items: [], changes: [], status: 'running', startedAt: 'x' });
    await store.save(s);
    const reopened = await SessionStore.open(dir);
    const r = reopened.get(s.id)!;
    expect(r.turns[0]).toMatchObject({ status: 'stopped' });
    expect(r.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Interrupted (server restarted)' }],
    });
  });
});

describe('repairSession', () => {
  it('drops a trailing paused turn whose server tool never finished', () => {
    const s: StoredSession = {
      id: 'x', title: '', createdAt: '', updatedAt: '', model: 'm', system: 's', seen: {}, turns: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      messages: [
        { role: 'user', content: 'search' },
        { role: 'assistant', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }] },
      ],
    };
    expect(repairSession(s)).toBe(true);
    expect(s.messages).toEqual([{ role: 'user', content: 'search' }]);
  });

  it('leaves a healthy session untouched', () => {
    const s: StoredSession = {
      id: 'x', title: '', createdAt: '', updatedAt: '', model: 'm', system: 's', seen: {}, turns: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }],
    };
    expect(repairSession(s)).toBe(false);
  });
});

describe('toPublic', () => {
  it('omits the API history and frozen prompt', async () => {
    const store = await SessionStore.open(null);
    const s = await store.create({ model: 'm', system: 'secret system' });
    const pub = toPublic(s, true);
    expect(pub.running).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('secret system');
    expect('messages' in pub).toBe(false);
  });
});

describe('prompt', () => {
  it('adds CLAUDE.md and the profile only when present', () => {
    const bare = buildSystemPrompt({});
    expect(bare).toContain('[[');
    expect(bare).not.toContain('<vault_claude_md>');
    expect(bare).not.toContain('<user_profile>');
    const full = buildSystemPrompt({ claudeMd: 'Use Swedish.', profile: 'I teach.' });
    expect(full).toContain('<vault_claude_md>\nUse Swedish.\n</vault_claude_md>');
    expect(full).toContain('<user_profile>\nI teach.\n</user_profile>');
  });

  it('wraps the prompt with the open note and selection', () => {
    expect(buildUserText('hi', {})).toBe('hi');
    const t = buildUserText('fix this', { path: 'a.md', selection: 'teh' });
    expect(t).toContain('Open note: a.md');
    expect(t).toContain('teh');
    expect(t.endsWith('fix this')).toBe(true);
  });
});
