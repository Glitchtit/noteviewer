import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveVaultPath } from './paths.js';

export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface NoteFile {
  content: string;
  mtimeMs: number;
  hash: string;
}

export async function readNote(root: string, rel: string): Promise<NoteFile> {
  const abs = resolveVaultPath(root, rel);
  const [content, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
  return { content, mtimeMs: stat.mtimeMs, hash: hashContent(content) };
}

export type WriteResult =
  | { conflict: false; mtimeMs: number; hash: string }
  | { conflict: true; current: NoteFile };

export async function writeNoteAtomic(
  root: string,
  rel: string,
  content: string,
  baseHash?: string,
): Promise<WriteResult> {
  const abs = resolveVaultPath(root, rel);
  if (baseHash !== undefined) {
    let current: NoteFile | null = null;
    try {
      current = await readNote(root, rel);
    } catch {
      // file missing: treat as create
    }
    if (current && current.hash !== baseHash) return { conflict: true, current };
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.tmp-${randomBytes(6).toString('hex')}`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, abs);
  const stat = await fs.stat(abs);
  return { conflict: false, mtimeMs: stat.mtimeMs, hash: hashContent(content) };
}

export async function uniqueCopyPath(root: string, rel: string): Promise<string> {
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const base = path.posix.basename(rel, ext);
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}-copy${ext}` : `${base}-copy-${i}${ext}`;
    const candidate = dir === '.' ? name : `${dir}/${name}`;
    try {
      await fs.access(resolveVaultPath(root, candidate));
    } catch {
      return candidate;
    }
  }
}
