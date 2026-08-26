import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { VaultEvent } from '@noteviewer/shared';
import { isHiddenName } from './files.js';
import type { VaultIndex } from './indexer.js';

export class VaultBus extends EventEmitter {
  emitEvent(e: VaultEvent): void {
    this.emit('event', e);
  }
  onEvent(fn: (e: VaultEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export type ChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export function createChangeHandler(index: VaultIndex, bus: VaultBus, root: string) {
  return async (kind: ChangeKind, absPath: string): Promise<void> => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    if (!rel || rel.split('/').some(isHiddenName)) return;
    if (kind === 'addDir' || kind === 'unlinkDir' || !rel.endsWith('.md')) {
      bus.emitEvent({ type: 'tree-changed' });
      return;
    }
    if (kind === 'unlink') index.removeNote(rel);
    else await index.updateNote(rel);
    if (kind !== 'change') bus.emitEvent({ type: 'tree-changed' });
    bus.emitEvent({ type: 'note-changed', path: rel });
  };
}

export function startWatcher(
  root: string,
  handler: ReturnType<typeof createChangeHandler>,
): FSWatcher {
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p: string) =>
      path.relative(root, p).split(path.sep).some((part) => part && isHiddenName(part)),
  });
  const kinds: ChangeKind[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'];
  for (const kind of kinds)
    watcher.on(kind, (p: string) => {
      handler(kind, p).catch((err) => {
        console.error(`watcher: failed handling ${kind} ${p}:`, err);
      });
    });
  return watcher;
}
