import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import type { TreeNode } from '@noteviewer/shared';
import { encodePath } from '../api';

/** dataTransfer type carrying the vault path of a dragged note. */
const DRAG_TYPE = 'application/x-noteviewer-note';
/** How long a dragged note must hover a collapsed folder before it opens. */
const HOVER_EXPAND_MS = 600;

export interface FileTreeProps {
  root: TreeNode;
  selected: string | null;
  expanded: ReadonlySet<string>;
  onOpenNote(path: string): void;
  onToggleFolder(path: string): void;
  /** Right-click on a note, a folder, or empty tree space (the root node). */
  onContextMenu?(node: TreeNode, x: number, y: number): void;
  /** A note was dropped on a folder ('' = vault root) other than its own. */
  onMoveNote?(from: string, toFolder: string): void;
}

export function collectFolderPaths(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.type === 'folder' && n.path) out.push(n.path);
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  return out;
}

export function parentFolder(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

interface TreeCtx {
  selected: string | null;
  expanded: ReadonlySet<string>;
  onOpenNote(p: string): void;
  onToggleFolder(p: string): void;
  onContextMenu?(node: TreeNode, x: number, y: number): void;
  dropTarget: string | null;
  dragOver(e: DragEvent, folder: string): void;
  drop(e: DragEvent, folder: string): void;
}

export function FileTree({
  root, selected, expanded, onOpenNote, onToggleFolder, onContextMenu, onMoveNote,
}: FileTreeProps) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);
  const hoverTimer = useRef<{ folder: string; id: ReturnType<typeof setTimeout> } | null>(null);

  const clearHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current.id);
    hoverTimer.current = null;
  };
  useEffect(() => clearHover, []);

  const endDrag = () => {
    dragging.current = null;
    setDropTarget(null);
    clearHover();
  };

  const ctx: TreeCtx = {
    selected,
    expanded,
    onOpenNote,
    onToggleFolder,
    onContextMenu,
    dropTarget,
    dragOver(e, folder) {
      if (!onMoveNote || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      // A drop into the note's own folder is a no-op; don't advertise it.
      const valid = dragging.current === null || parentFolder(dragging.current) !== folder;
      e.dataTransfer.dropEffect = valid ? 'move' : 'none';
      setDropTarget(valid ? folder : null);
      if (folder && !expanded.has(folder)) {
        if (hoverTimer.current?.folder !== folder) {
          clearHover();
          hoverTimer.current = {
            folder,
            id: setTimeout(() => {
              hoverTimer.current = null;
              if (!expanded.has(folder)) onToggleFolder(folder);
            }, HOVER_EXPAND_MS),
          };
        }
      } else {
        clearHover();
      }
    },
    drop(e, folder) {
      const from = e.dataTransfer.getData(DRAG_TYPE);
      if (!onMoveNote || !from) return;
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      if (parentFolder(from) !== folder) onMoveNote(from, folder);
    },
  };

  return (
    <div
      className={`filetree${dropTarget === '' ? ' drop-target' : ''}`}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(root, e.clientX, e.clientY);
      }}
      onDragStart={(e) => {
        const p = (e.target as HTMLElement).dataset?.notePath;
        if (!p || !onMoveNote) return;
        dragging.current = p;
        e.dataTransfer.setData(DRAG_TYPE, p);
        e.dataTransfer.setData('text/plain', p);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={endDrag}
      onDragOver={(e) => ctx.dragOver(e, '')}
      onDragLeave={(e) => {
        // Leaving the whole tree (not just moving between children) clears the highlight.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropTarget(null);
          clearHover();
        }
      }}
      onDrop={(e) => ctx.drop(e, '')}
    >
      {(root.children ?? []).map((n) => (
        <TreeEntry key={n.path} node={n} ctx={ctx} depth={0} draggable={!!onMoveNote} />
      ))}
    </div>
  );
}

function TreeEntry({
  node, ctx, depth, draggable,
}: {
  node: TreeNode;
  ctx: TreeCtx;
  depth: number;
  draggable: boolean;
}) {
  const pad = { paddingLeft: `${8 + depth * 14}px` };
  const menu = ctx.onContextMenu
    ? (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.onContextMenu!(node, e.clientX, e.clientY);
      }
    : undefined;

  if (node.type === 'folder') {
    const open = ctx.expanded.has(node.path);
    return (
      <div
        className={ctx.dropTarget === node.path ? 'drop-target' : undefined}
        onDragOver={(e) => ctx.dragOver(e, node.path)}
        onDrop={(e) => ctx.drop(e, node.path)}
      >
        <button
          className="tree-item tree-folder"
          style={pad}
          onClick={() => ctx.onToggleFolder(node.path)}
          onContextMenu={menu}
        >
          <span className="tree-chevron">{open ? '▾' : '▸'}</span>
          {node.name}
        </button>
        {open &&
          (node.children ?? []).map((c) => (
            <TreeEntry key={c.path} node={c} ctx={ctx} depth={depth + 1} draggable={draggable} />
          ))}
      </div>
    );
  }

  if (node.type === 'note') {
    return (
      <button
        className={`tree-item tree-note${ctx.selected === node.path ? ' selected' : ''}`}
        style={pad}
        draggable={draggable}
        data-note-path={node.path}
        onClick={() => ctx.onOpenNote(node.path)}
        onContextMenu={menu}
      >
        {node.name.replace(/\.md$/, '')}
      </button>
    );
  }

  return (
    <a
      className="tree-item tree-file"
      style={pad}
      href={`/api/file/${encodePath(node.path)}`}
      target="_blank"
      rel="noreferrer"
      draggable={false}
    >
      {node.name}
    </a>
  );
}
