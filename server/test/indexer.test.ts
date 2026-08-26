import { describe, expect, it } from 'vitest';
import { VaultIndex } from '../src/vault/indexer.js';
import { makeVault } from './helpers.js';

async function indexed(files: Record<string, string>) {
  const index = new VaultIndex(await makeVault(files));
  await index.init();
  return index;
}

describe('VaultIndex', () => {
  it('indexes all markdown, skipping hidden dirs', async () => {
    const index = await indexed({
      'a.md': '# A',
      'sub/b.md': '# B',
      '.obsidian/x.md': 'not indexed',
      '.trash/y.md': 'not indexed',
    });
    expect(index.allNotes().map((n) => n.path).sort()).toEqual(['a.md', 'sub/b.md']);
    expect(index.getMeta('a.md')!.title).toBe('A');
  });

  it('falls back to filename as title', async () => {
    const index = await indexed({ 'No Heading.md': 'just text' });
    expect(index.getMeta('No Heading.md')!.title).toBe('No Heading');
  });

  it('resolves links by exact path and by shortest basename match', async () => {
    const index = await indexed({
      'Note.md': '',
      'deep/dir/Note.md': '',
      'deep/Other.md': '',
    });
    expect(index.resolveLink('deep/Other')).toBe('deep/Other.md');
    expect(index.resolveLink('Note')).toBe('Note.md');
    expect(index.resolveLink('other')).toBe('deep/Other.md');
    expect(index.resolveLink('Missing')).toBeUndefined();
  });

  it('computes backlinks through link resolution', async () => {
    const index = await indexed({
      'a.md': 'links to [[b]] and [[sub/c]]',
      'b.md': 'links to [[sub/c|alias]]',
      'sub/c.md': 'no links',
    });
    expect(index.backlinksOf('sub/c.md')).toEqual(['a.md', 'b.md']);
    expect(index.backlinksOf('b.md')).toEqual(['a.md']);
    expect(index.backlinksOf('a.md')).toEqual([]);
  });

  it('updates and removes notes incrementally', async () => {
    const index = await indexed({ 'a.md': '# Old', 'b.md': '[[a]]' });
    const root = index.root;
    const { writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await writeFile(path.join(root, 'a.md'), '# New');
    await index.updateNote('a.md');
    expect(index.getMeta('a.md')!.title).toBe('New');
    index.removeNote('b.md');
    expect(index.backlinksOf('a.md')).toEqual([]);
  });
});
