import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeRecord } from '@noteviewer/shared';
import { VaultIndex } from '../src/vault/indexer.js';
import { VaultBus } from '../src/vault/watcher.js';
import { ShareStore } from '../src/share/store.js';
import { writeNote, type VaultCtx } from '../src/vault/ops.js';
import { VaultTools } from '../src/ai/tools.js';
import { undoChanges } from '../src/ai/journal.js';
import { makeVault } from './helpers.js';

async function setup(files: Record<string, string>) {
  const vaultRoot = await makeVault(files);
  const index = new VaultIndex(vaultRoot);
  await index.init();
  const ctx: VaultCtx = { vaultRoot, index, bus: new VaultBus(), shares: await ShareStore.open() };
  const tools = new VaultTools(ctx, {});
  const records: ChangeRecord[] = [];
  let n = 0;
  const run = async (name: string, input: object) => {
    const out = await tools.run(name, input);
    if (out.isError) throw new Error(String(out.content));
    if (out.change) records.push({ ...out.change, id: `c${++n}` });
  };
  const read = (rel: string) => readFile(path.join(vaultRoot, rel), 'utf8');
  const missing = async (rel: string) => access(path.join(vaultRoot, rel)).then(() => false, () => true);
  return { ctx, run, records, read, missing };
}

describe('undoChanges', () => {
  it('restores an edited note', async () => {
    const { ctx, run, records, read } = await setup({ 'a.md': 'one' });
    await run('read', { path: 'a.md' });
    await run('edit', { path: 'a.md', old_string: 'one', new_string: 'two' });
    const results = await undoChanges(ctx, records);
    expect(results).toEqual([{ id: 'c1', status: 'undone' }]);
    expect(await read('a.md')).toBe('one');
    expect(records[0]!.undone).toBe(true);
  });

  it('trashes a created note', async () => {
    const { ctx, run, records, missing } = await setup({});
    await run('write', { path: 'n.md', content: 'new' });
    await undoChanges(ctx, records);
    expect(await missing('n.md')).toBe(true);
  });

  it('recreates a deleted note', async () => {
    const { ctx, run, records, read } = await setup({ 'a.md': 'keep me' });
    await run('delete', { path: 'a.md' });
    await undoChanges(ctx, records);
    expect(await read('a.md')).toBe('keep me');
  });

  it('moves a note back and restores links to it', async () => {
    const { ctx, run, records, read, missing } = await setup({ 'a.md': 'A', 'b.md': '[[a]]' });
    await run('move', { from: 'a.md', to: 'x/c.md' });
    expect(await read('b.md')).toBe('[[c]]');
    await undoChanges(ctx, records);
    expect(await read('a.md')).toBe('A');
    expect(await missing('x/c.md')).toBe(true);
    expect(await read('b.md')).toBe('[[a]]');
  });

  it('undoes newest first', async () => {
    const { ctx, run, records, read } = await setup({ 'a.md': 'v1' });
    await run('read', { path: 'a.md' });
    await run('edit', { path: 'a.md', old_string: 'v1', new_string: 'v2' });
    await run('edit', { path: 'a.md', old_string: 'v2', new_string: 'v3' });
    const results = await undoChanges(ctx, records);
    expect(results.map((r) => r.id)).toEqual(['c2', 'c1']);
    expect(await read('a.md')).toBe('v1');
  });

  it('only undoes the requested ids and skips already-undone records', async () => {
    const { ctx, run, records, read } = await setup({});
    await run('write', { path: 'a.md', content: 'a' });
    await run('write', { path: 'b.md', content: 'b' });
    expect(await undoChanges(ctx, records, ['c2'])).toEqual([{ id: 'c2', status: 'undone' }]);
    expect(await read('a.md')).toBe('a');
    expect(await undoChanges(ctx, records, ['c2'])).toEqual([]);
  });

  describe('when the user changed the file after the agent', () => {
    async function conflicted() {
      const s = await setup({ 'a.md': 'original' });
      await s.run('read', { path: 'a.md' });
      await s.run('edit', { path: 'a.md', old_string: 'original', new_string: 'agent' });
      await writeNote(s.ctx, 'a.md', 'user edit');
      return s;
    }

    it('reports a conflict and leaves the file alone', async () => {
      const { ctx, records, read } = await conflicted();
      expect(await undoChanges(ctx, records)).toEqual([{ id: 'c1', status: 'conflict', message: expect.any(String) }]);
      expect(await read('a.md')).toBe('user edit');
      expect(records[0]!.undone).toBeFalsy();
    });

    it('restores the old version as a copy', async () => {
      const { ctx, records, read } = await conflicted();
      const [r] = await undoChanges(ctx, records, ['c1'], 'copy');
      expect(r).toEqual({ id: 'c1', status: 'copied', copyPath: 'a-copy.md' });
      expect(await read('a-copy.md')).toBe('original');
      expect(await read('a.md')).toBe('user edit');
      expect(records[0]!.undone).toBe(true);
    });

    it('overwrites when asked', async () => {
      const { ctx, records, read } = await conflicted();
      expect((await undoChanges(ctx, records, ['c1'], 'overwrite'))[0]!.status).toBe('undone');
      expect(await read('a.md')).toBe('original');
    });

    it('skips when asked', async () => {
      const { ctx, records, read } = await conflicted();
      expect((await undoChanges(ctx, records, ['c1'], 'skip'))[0]!.status).toBe('skipped');
      expect(await read('a.md')).toBe('user edit');
      expect(records[0]!.undone).toBe(true);
    });
  });

  it('treats a recreated path as a conflict when undoing a delete', async () => {
    const { ctx, run, records, read } = await setup({ 'a.md': 'old' });
    await run('delete', { path: 'a.md' });
    await writeNote(ctx, 'a.md', 'someone else');
    expect((await undoChanges(ctx, records))[0]!.status).toBe('conflict');
    const [r] = await undoChanges(ctx, records, undefined, 'copy');
    expect(r!.copyPath).toBe('a-copy.md');
    expect(await read('a-copy.md')).toBe('old');
  });
});
