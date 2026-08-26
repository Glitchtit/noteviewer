import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTree, trashNote } from '../src/vault/files.js';
import { makeVault } from './helpers.js';

describe('buildTree', () => {
  it('builds a sorted tree, folders first, hidden entries skipped', async () => {
    const root = await makeVault({
      'b.md': '',
      'a.md': '',
      'img.png': '',
      'sub/inner.md': '',
      '.obsidian/app.json': '{}',
      '.trash/old.md': '',
    });
    const tree = await buildTree(root);
    expect(tree.children!.map((c) => c.path)).toEqual(['sub', 'a.md', 'b.md', 'img.png']);
    expect(tree.children![0]!.children!.map((c) => c.path)).toEqual(['sub/inner.md']);
    expect(tree.children!.find((c) => c.path === 'img.png')!.type).toBe('file');
    expect(tree.children!.find((c) => c.path === 'a.md')!.type).toBe('note');
  });
});

describe('trashNote', () => {
  it('moves the note into .trash and dodges collisions', async () => {
    const root = await makeVault({ 'n.md': 'one', '.trash/n.md': 'earlier' });
    const dest = await trashNote(root, 'n.md');
    expect(dest).toBe('.trash/n-2.md');
    expect(await readFile(path.join(root, dest), 'utf8')).toBe('one');
  });
});
