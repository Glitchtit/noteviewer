/**
 * Undo for agent changes. Records are played back newest first; a record whose
 * file was changed by someone else since the agent touched it is reported as
 * a conflict unless the caller picks a resolution — "copy" (restore the old
 * version beside the current one) is the non-destructive choice.
 */

import type { ChangeRecord, UndoResolution, UndoResult } from '@noteviewer/shared';
import { readNote, uniqueCopyPath } from '../vault/files.js';
import { deleteNote, exists, renameNote, writeNote, type VaultCtx } from '../vault/ops.js';

export type { UndoResolution };

async function currentHash(ctx: VaultCtx, rel: string): Promise<string | null> {
  try {
    return (await readNote(ctx.vaultRoot, rel)).hash;
  } catch {
    return null;
  }
}

async function restoreAsCopy(ctx: VaultCtx, rel: string, content: string): Promise<string> {
  const copyPath = await uniqueCopyPath(ctx.vaultRoot, rel);
  await writeNote(ctx, copyPath, content);
  return copyPath;
}

async function undoOne(ctx: VaultCtx, r: ChangeRecord, resolution?: UndoResolution): Promise<UndoResult> {
  const conflict = (message: string): UndoResult => ({ id: r.id, status: 'conflict', message });

  switch (r.op) {
    case 'create': {
      const hash = await currentHash(ctx, r.path);
      if (hash === null) return { id: r.id, status: 'undone' };
      if (hash !== r.afterHash) {
        if (resolution === 'overwrite') break;
        if (resolution) return { id: r.id, status: 'skipped' };
        return conflict(`${r.path} was edited after the agent created it`);
      }
      break;
    }
    case 'write':
    case 'edit': {
      const hash = await currentHash(ctx, r.path);
      if (hash !== r.afterHash) {
        if (!resolution) {
          return conflict(hash === null ? `${r.path} no longer exists` : `${r.path} was edited after the agent changed it`);
        }
        if (resolution === 'skip') return { id: r.id, status: 'skipped' };
        if (resolution === 'copy') {
          return { id: r.id, status: 'copied', copyPath: await restoreAsCopy(ctx, r.path, r.before ?? '') };
        }
      }
      break;
    }
    case 'move': {
      const hash = await currentHash(ctx, r.path);
      const fromTaken = await exists(ctx, r.from!);
      if (hash !== r.afterHash || fromTaken) {
        const why = fromTaken
          ? `${r.from} exists again`
          : hash === null
            ? `${r.path} no longer exists`
            : `${r.path} was edited after the move`;
        if (!resolution) return conflict(why);
        if (resolution !== 'overwrite' || fromTaken || hash === null) return { id: r.id, status: 'skipped', message: why };
      }
      break;
    }
    case 'delete': {
      if (await exists(ctx, r.path)) {
        if (!resolution) return conflict(`${r.path} exists again`);
        if (resolution === 'skip') return { id: r.id, status: 'skipped' };
        if (resolution === 'copy') {
          return { id: r.id, status: 'copied', copyPath: await restoreAsCopy(ctx, r.path, r.before ?? '') };
        }
      }
      break;
    }
  }

  // apply the inverse operation
  switch (r.op) {
    case 'create':
      await deleteNote(ctx, r.path);
      break;
    case 'write':
    case 'edit':
    case 'delete': {
      const res = await writeNote(ctx, r.path, r.before ?? '');
      if (res.conflict) return { id: r.id, status: 'failed', message: 'write conflict' };
      break;
    }
    case 'move': {
      const res = await renameNote(ctx, r.path, r.from!);
      if (!res) return { id: r.id, status: 'failed', message: `${r.from} exists` };
      break;
    }
  }
  return { id: r.id, status: 'undone' };
}

/**
 * Undo the given records (all not-yet-undone ones when `ids` is omitted),
 * newest first. Marks each successfully undone, copied or skipped record
 * `undone: true` in place.
 */
export async function undoChanges(
  ctx: VaultCtx,
  records: ChangeRecord[],
  ids?: string[],
  resolution?: UndoResolution,
): Promise<UndoResult[]> {
  const wanted = ids ? new Set(ids) : undefined;
  const results: UndoResult[] = [];
  for (const r of [...records].reverse()) {
    if (r.undone || (wanted && !wanted.has(r.id))) continue;
    let result: UndoResult;
    try {
      result = await undoOne(ctx, r, resolution);
    } catch (err) {
      result = { id: r.id, status: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
    if (result.status === 'undone' || result.status === 'copied' || result.status === 'skipped') {
      r.undone = true;
      r.undoStatus = result.status;
      if (result.copyPath) r.copyPath = result.copyPath;
    }
    results.push(result);
  }
  return results;
}

