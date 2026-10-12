/**
 * Vault mutations with their side effects (search index, live-update bus,
 * share links). Shared by the HTTP routes and the AI agent's tools so both
 * behave identically.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ShareStore } from '../share/store.js';
import { readNote, trashNote, uniqueCopyPath, writeNoteAtomic, type WriteResult } from './files.js';
import type { VaultIndex } from './indexer.js';
import { resolveVaultPath } from './paths.js';
import { rewriteLinks } from './rename.js';
import type { VaultBus } from './watcher.js';

export interface VaultCtx {
  vaultRoot: string;
  index: VaultIndex;
  bus: VaultBus;
  shares: ShareStore;
}

export async function exists(ctx: VaultCtx, rel: string): Promise<boolean> {
  try {
    await fs.access(resolveVaultPath(ctx.vaultRoot, rel));
    return true;
  } catch {
    return false;
  }
}

/** Write a note (creating it and its folders if needed); `baseHash` guards against lost updates. */
export async function writeNote(ctx: VaultCtx, rel: string, content: string, baseHash?: string): Promise<WriteResult> {
  const isNew = !(await exists(ctx, rel));
  const result = await writeNoteAtomic(ctx.vaultRoot, rel, content, baseHash);
  if (result.conflict) return result;
  await ctx.index.updateNote(rel);
  if (isNew) ctx.bus.emitEvent({ type: 'tree-changed' });
  ctx.bus.emitEvent({ type: 'note-changed', path: rel });
  return result;
}

/** Create a note; returns null when the path is taken and `unique` is false. */
export async function createNote(
  ctx: VaultCtx,
  rel: string,
  content: string,
  unique: boolean,
): Promise<{ path: string; mtimeMs: number; hash: string } | null> {
  let target = rel;
  if (await exists(ctx, target)) {
    if (!unique) return null;
    target = await uniqueCopyPath(ctx.vaultRoot, target);
  }
  const result = await writeNoteAtomic(ctx.vaultRoot, target, content);
  if (result.conflict) return null;
  await ctx.index.updateNote(target);
  ctx.bus.emitEvent({ type: 'tree-changed' });
  ctx.bus.emitEvent({ type: 'note-changed', path: target });
  return { path: target, mtimeMs: result.mtimeMs, hash: result.hash };
}

/** Move a note to the vault's .trash; returns its path there. */
export async function deleteNote(ctx: VaultCtx, rel: string): Promise<string> {
  const trashedTo = await trashNote(ctx.vaultRoot, rel);
  ctx.index.removeNote(rel);
  await ctx.shares.removePath(rel);
  ctx.bus.emitEvent({ type: 'tree-changed' });
  return trashedTo;
}

/**
 * Rename/move a note and rewrite wikilinks to it in every note that links
 * here. Returns null when the target already exists.
 */
export async function renameNote(ctx: VaultCtx, from: string, to: string): Promise<{ rewritten: string[] } | null> {
  const fromAbs = resolveVaultPath(ctx.vaultRoot, from);
  const toAbs = resolveVaultPath(ctx.vaultRoot, to);
  if (await exists(ctx, to)) return null;
  const referrers = ctx.index.backlinksOf(from);
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  const oldName = path.posix.basename(from, '.md');
  const newName = path.posix.basename(to, '.md');
  const fromPathNoExt = from.slice(0, -'.md'.length);
  const toPathNoExt = to.slice(0, -'.md'.length);
  const applyRewrites = (content: string): string => {
    let updated = rewriteLinks(content, oldName, newName);
    if (fromPathNoExt !== oldName) {
      updated = rewriteLinks(updated, fromPathNoExt, toPathNoExt);
    }
    return updated;
  };
  const rewritten: string[] = [];
  for (const ref of referrers) {
    let file = await readNote(ctx.vaultRoot, ref);
    const updated = applyRewrites(file.content);
    if (updated !== file.content) {
      let result = await writeNoteAtomic(ctx.vaultRoot, ref, updated, file.hash);
      if (result.conflict) {
        // Retry: re-read and attempt write with fresh hash
        file = await readNote(ctx.vaultRoot, ref);
        const retryUpdated = applyRewrites(file.content);
        if (retryUpdated !== file.content) {
          result = await writeNoteAtomic(ctx.vaultRoot, ref, retryUpdated, file.hash);
        }
      }
      // Only include in rewritten if write succeeded (no conflict)
      if (!result.conflict) {
        await ctx.index.updateNote(ref);
        rewritten.push(ref);
      }
    }
  }
  ctx.index.removeNote(from);
  await ctx.index.updateNote(to);
  await ctx.shares.renamePath(from, to);
  ctx.bus.emitEvent({ type: 'tree-changed' });
  for (const ref of rewritten) ctx.bus.emitEvent({ type: 'note-changed', path: ref });
  return { rewritten };
}
