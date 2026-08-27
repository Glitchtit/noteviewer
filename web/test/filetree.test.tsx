import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '@noteviewer/shared';
import { collectFolderPaths, FileTree } from '../src/components/FileTree';

const fixture: TreeNode = {
  name: '', path: '', type: 'folder',
  children: [
    {
      name: 'sub', path: 'sub', type: 'folder',
      children: [{ name: 'inner.md', path: 'sub/inner.md', type: 'note' }],
    },
    { name: 'a.md', path: 'a.md', type: 'note' },
    { name: 'img.png', path: 'img.png', type: 'file' },
  ],
};

function Harness({
  selected = null, onOpenNote = () => {}, initialExpanded = [],
}: {
  selected?: string | null; onOpenNote?(p: string): void; initialExpanded?: string[];
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(initialExpanded));
  return (
    <FileTree
      root={fixture}
      selected={selected}
      expanded={expanded}
      onOpenNote={onOpenNote}
      onToggleFolder={(p) => {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(p)) next.delete(p); else next.add(p);
          return next;
        });
      }}
    />
  );
}

describe('FileTree', () => {
  it('renders notes without .md and calls onOpenNote', () => {
    const onOpen = vi.fn();
    render(<Harness onOpenNote={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onOpen).toHaveBeenCalledWith('a.md');
  });

  it('starts collapsed and expands/collapses on click', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'inner' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /sub/ }));
    expect(screen.getByRole('button', { name: 'inner' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /sub/ }));
    expect(screen.queryByRole('button', { name: 'inner' })).toBeNull();
  });

  it('shows nested entries when their folder is in the expanded set', () => {
    render(<Harness initialExpanded={['sub']} />);
    expect(screen.getByRole('button', { name: 'inner' })).toBeTruthy();
  });

  it('links attachments to /api/file and marks the selected note', () => {
    render(<Harness selected="a.md" />);
    const link = screen.getByRole('link', { name: 'img.png' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/file/img.png');
    expect(screen.getByRole('button', { name: 'a' }).className).toContain('selected');
  });
});

describe('collectFolderPaths', () => {
  it('collects every folder path, skipping the unnamed root', () => {
    expect(collectFolderPaths(fixture)).toEqual(['sub']);
  });
});
