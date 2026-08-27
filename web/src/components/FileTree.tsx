import type { TreeNode } from '@noteviewer/shared';
import { encodePath } from '../api';

export interface FileTreeProps {
  root: TreeNode;
  selected: string | null;
  expanded: ReadonlySet<string>;
  onOpenNote(path: string): void;
  onToggleFolder(path: string): void;
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

export function FileTree({ root, selected, expanded, onOpenNote, onToggleFolder }: FileTreeProps) {
  return (
    <div className="filetree">
      {(root.children ?? []).map((n) => (
        <TreeEntry
          key={n.path}
          node={n}
          selected={selected}
          expanded={expanded}
          onOpenNote={onOpenNote}
          onToggleFolder={onToggleFolder}
          depth={0}
        />
      ))}
    </div>
  );
}

function TreeEntry({
  node, selected, expanded, onOpenNote, onToggleFolder, depth,
}: {
  node: TreeNode;
  selected: string | null;
  expanded: ReadonlySet<string>;
  onOpenNote(p: string): void;
  onToggleFolder(p: string): void;
  depth: number;
}) {
  const pad = { paddingLeft: `${8 + depth * 14}px` };

  if (node.type === 'folder') {
    const open = expanded.has(node.path);
    return (
      <div>
        <button className="tree-item tree-folder" style={pad} onClick={() => onToggleFolder(node.path)}>
          <span className="tree-chevron">{open ? '▾' : '▸'}</span>
          {node.name}
        </button>
        {open &&
          (node.children ?? []).map((c) => (
            <TreeEntry
              key={c.path}
              node={c}
              selected={selected}
              expanded={expanded}
              onOpenNote={onOpenNote}
              onToggleFolder={onToggleFolder}
              depth={depth + 1}
            />
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
