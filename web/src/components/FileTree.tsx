import { useState } from 'react';
import type { TreeNode } from '@noteviewer/shared';
import { encodePath } from '../api';

export interface FileTreeProps {
  root: TreeNode;
  selected: string | null;
  onOpenNote(path: string): void;
}

export function FileTree({ root, selected, onOpenNote }: FileTreeProps) {
  return (
    <div className="filetree">
      {(root.children ?? []).map((n) => (
        <TreeEntry key={n.path} node={n} selected={selected} onOpenNote={onOpenNote} depth={0} />
      ))}
    </div>
  );
}

function TreeEntry({
  node, selected, onOpenNote, depth,
}: {
  node: TreeNode; selected: string | null; onOpenNote(p: string): void; depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pad = { paddingLeft: `${8 + depth * 14}px` };

  if (node.type === 'folder') {
    return (
      <div>
        <button className="tree-item tree-folder" style={pad} onClick={() => setCollapsed((c) => !c)}>
          <span className="tree-chevron">{collapsed ? '▸' : '▾'}</span>
          {node.name}
        </button>
        {!collapsed &&
          (node.children ?? []).map((c) => (
            <TreeEntry key={c.path} node={c} selected={selected} onOpenNote={onOpenNote} depth={depth + 1} />
          ))}
      </div>
    );
  }

  if (node.type === 'note') {
    return (
      <button
        className={`tree-item tree-note${selected === node.path ? ' selected' : ''}`}
        style={pad}
        onClick={() => onOpenNote(node.path)}
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
    >
      {node.name}
    </a>
  );
}
