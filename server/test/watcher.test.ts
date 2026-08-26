import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VaultEvent } from '@noteviewer/shared';
import { VaultIndex } from '../src/vault/indexer.js';
import { VaultBus, createChangeHandler } from '../src/vault/watcher.js';
import { makeVault } from './helpers.js';

async function setup(files: Record<string, string>) {
  const root = await makeVault(files);
  const index = new VaultIndex(root);
  await index.init();
  const bus = new VaultBus();
  const events: VaultEvent[] = [];
  bus.onEvent((e) => events.push(e));
  return { root, index, bus, events, handler: createChangeHandler(index, bus, root) };
}

describe('createChangeHandler', () => {
  it('indexes changed markdown and emits note-changed', async () => {
    const s = await setup({ 'a.md': '# Old' });
    await writeFile(path.join(s.root, 'a.md'), '# New');
    await s.handler('change', path.join(s.root, 'a.md'));
    expect(s.index.getMeta('a.md')!.title).toBe('New');
    expect(s.events).toEqual([{ type: 'note-changed', path: 'a.md' }]);
  });

  it('removes unlinked notes and emits both events', async () => {
    const s = await setup({ 'a.md': 'x' });
    await s.handler('unlink', path.join(s.root, 'a.md'));
    expect(s.index.getMeta('a.md')).toBeUndefined();
    expect(s.events).toEqual([
      { type: 'tree-changed' },
      { type: 'note-changed', path: 'a.md' },
    ]);
  });

  it('ignores hidden paths entirely', async () => {
    const s = await setup({});
    await s.handler('add', path.join(s.root, '.git/objects/aa'));
    await s.handler('change', path.join(s.root, '.trash/x.md'));
    expect(s.events).toEqual([]);
  });

  it('emits only tree-changed for attachments and folders', async () => {
    const s = await setup({ 'img.png': '' });
    await s.handler('add', path.join(s.root, 'img.png'));
    await s.handler('addDir', path.join(s.root, 'newdir'));
    expect(s.events).toEqual([{ type: 'tree-changed' }, { type: 'tree-changed' }]);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new VaultBus();
    const seen: VaultEvent[] = [];
    const off = bus.onEvent((e) => seen.push(e));
    bus.emitEvent({ type: 'tree-changed' });
    off();
    bus.emitEvent({ type: 'tree-changed' });
    expect(seen).toHaveLength(1);
  });
});
