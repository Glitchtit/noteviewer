import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hashContent,
  isHiddenName,
  readNote,
  uniqueCopyPath,
  writeNoteAtomic,
} from '../src/vault/files.js';
import { makeVault } from './helpers.js';

describe('files', () => {
  it('reads a note with hash and mtime', async () => {
    const root = await makeVault({ 'a.md': 'hello' });
    const n = await readNote(root, 'a.md');
    expect(n.content).toBe('hello');
    expect(n.hash).toBe(hashContent('hello'));
    expect(n.mtimeMs).toBeGreaterThan(0);
  });

  it('writes without conflict when baseHash matches', async () => {
    const root = await makeVault({ 'a.md': 'v1' });
    const r = await writeNoteAtomic(root, 'a.md', 'v2', hashContent('v1'));
    expect(r.conflict).toBe(false);
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('v2');
  });

  it('reports conflict with current disk content when baseHash is stale', async () => {
    const root = await makeVault({ 'a.md': 'disk-version' });
    const r = await writeNoteAtomic(root, 'a.md', 'mine', hashContent('old-version'));
    expect(r.conflict).toBe(true);
    if (r.conflict) expect(r.current.content).toBe('disk-version');
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('disk-version');
  });

  it('creates missing files and parent dirs, leaves no temp files', async () => {
    const root = await makeVault({});
    const r = await writeNoteAtomic(root, 'deep/dir/new.md', 'x');
    expect(r.conflict).toBe(false);
    expect(await readFile(path.join(root, 'deep/dir/new.md'), 'utf8')).toBe('x');
    expect((await readdir(path.join(root, 'deep/dir'))).sort()).toEqual(['new.md']);
  });

  it('finds a free -copy name', async () => {
    const root = await makeVault({ 'n.md': '', 'n-copy.md': '' });
    expect(await uniqueCopyPath(root, 'n.md')).toBe('n-copy-2.md');
  });

  it('classifies hidden names', () => {
    expect(isHiddenName('.obsidian')).toBe(true);
    expect(isHiddenName('node_modules')).toBe(true);
    expect(isHiddenName('Notes')).toBe(false);
  });
});
