import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VaultEvent } from '@noteviewer/shared';
import { VaultIndex } from '../src/vault/indexer.js';
import { VaultBus } from '../src/vault/watcher.js';
import { ShareStore } from '../src/share/store.js';
import { hashContent } from '../src/vault/files.js';
import { createNote, deleteNote, renameNote, writeNote, type VaultCtx } from '../src/vault/ops.js';
import { makeVault } from './helpers.js';

async function ctxFor(files: Record<string, string>): Promise<{ ctx: VaultCtx; events: VaultEvent[] }> {
  const vaultRoot = await makeVault(files);
  const index = new VaultIndex(vaultRoot);
  await index.init();
  const bus = new VaultBus();
  const events: VaultEvent[] = [];
  bus.onEvent((e) => events.push(e));
  return { ctx: { vaultRoot, index, bus, shares: await ShareStore.open() }, events };
}

describe('vault ops', () => {
  it('writeNote creates a new note, indexes it and announces the tree change', async () => {
    const { ctx, events } = await ctxFor({});
    const res = await writeNote(ctx, 'dir/new.md', '# New');
    expect(res.conflict).toBe(false);
    expect(ctx.index.getMeta('dir/new.md')?.title).toBe('New');
    expect(events).toEqual([{ type: 'tree-changed' }, { type: 'note-changed', path: 'dir/new.md' }]);
  });

  it('writeNote on an existing note only announces the note change', async () => {
    const { ctx, events } = await ctxFor({ 'a.md': 'x' });
    await writeNote(ctx, 'a.md', 'y', hashContent('x'));
    expect(events).toEqual([{ type: 'note-changed', path: 'a.md' }]);
  });

  it('writeNote with a stale base hash writes nothing', async () => {
    const { ctx, events } = await ctxFor({ 'a.md': 'x' });
    const res = await writeNote(ctx, 'a.md', 'y', hashContent('old'));
    expect(res.conflict).toBe(true);
    expect(await readFile(path.join(ctx.vaultRoot, 'a.md'), 'utf8')).toBe('x');
    expect(events).toEqual([]);
  });

  it('createNote refuses an existing path unless unique', async () => {
    const { ctx } = await ctxFor({ 'a.md': 'x' });
    expect(await createNote(ctx, 'a.md', 'y', false)).toBeNull();
    const res = await createNote(ctx, 'a.md', 'y', true);
    expect(res?.path).toBe('a-copy.md');
  });

  it('renameNote moves the note and rewrites links to it', async () => {
    const { ctx } = await ctxFor({ 'a.md': '# A', 'b.md': 'see [[a]]' });
    const res = await renameNote(ctx, 'a.md', 'sub/c.md');
    expect(res).toEqual({ rewritten: ['b.md'] });
    expect(await readFile(path.join(ctx.vaultRoot, 'b.md'), 'utf8')).toBe('see [[c]]');
    expect(ctx.index.getMeta('sub/c.md')).toBeDefined();
    expect(ctx.index.getMeta('a.md')).toBeUndefined();
  });

  it('renameNote returns null when the target exists', async () => {
    const { ctx } = await ctxFor({ 'a.md': 'a', 'b.md': 'b' });
    expect(await renameNote(ctx, 'a.md', 'b.md')).toBeNull();
    expect(await readFile(path.join(ctx.vaultRoot, 'a.md'), 'utf8')).toBe('a');
  });

  it('deleteNote moves the note to .trash and drops it from the index', async () => {
    const { ctx, events } = await ctxFor({ 'a.md': 'a' });
    const trashedTo = await deleteNote(ctx, 'a.md');
    expect(trashedTo).toBe('.trash/a.md');
    await expect(access(path.join(ctx.vaultRoot, 'a.md'))).rejects.toThrow();
    expect(ctx.index.getMeta('a.md')).toBeUndefined();
    expect(events).toEqual([{ type: 'tree-changed' }]);
  });
});
