import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
  selected = null, onOpenNote = () => {}, initialExpanded = [], onContextMenu, onMoveNote,
}: {
  selected?: string | null; onOpenNote?(p: string): void; initialExpanded?: string[];
  onContextMenu?(node: TreeNode, x: number, y: number): void;
  onMoveNote?(from: string, toFolder: string): void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(initialExpanded));
  return (
    <FileTree
      root={fixture}
      selected={selected}
      expanded={expanded}
      onOpenNote={onOpenNote}
      onContextMenu={onContextMenu}
      onMoveNote={onMoveNote}
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

/** jsdom has no DataTransfer; one fake shared across a drag's events stands in. */
function fakeDataTransfer() {
  const data: Record<string, string> = {};
  return {
    get types() { return Object.keys(data); },
    setData(type: string, value: string) { data[type] = value; },
    getData(type: string) { return data[type] ?? ''; },
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

describe('FileTree context menu', () => {
  it('reports right-clicks on notes, folders and empty space', () => {
    const onMenu = vi.fn();
    const { container } = render(<Harness onContextMenu={onMenu} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'a' }), { clientX: 5, clientY: 6 });
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'a.md' }), 5, 6);
    fireEvent.contextMenu(screen.getByRole('button', { name: /sub/ }));
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'sub', type: 'folder' }), 0, 0);
    fireEvent.contextMenu(container.querySelector('.filetree')!);
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ path: '' }), 0, 0);
    expect(onMenu).toHaveBeenCalledTimes(3);
  });
});

describe('FileTree drag and drop', () => {
  it('moves a note dropped on another folder', () => {
    const onMove = vi.fn();
    render(<Harness onMoveNote={onMove} />);
    const dt = fakeDataTransfer();
    const note = screen.getByRole('button', { name: 'a' });
    const folder = screen.getByRole('button', { name: /sub/ });
    expect(note.getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(note, { dataTransfer: dt });
    fireEvent.dragOver(folder, { dataTransfer: dt });
    expect(folder.parentElement!.className).toContain('drop-target');
    fireEvent.drop(folder, { dataTransfer: dt });
    expect(onMove).toHaveBeenCalledWith('a.md', 'sub');
    expect(folder.parentElement!.className).not.toContain('drop-target');
  });

  it('moves a nested note to the root when dropped on empty space', () => {
    const onMove = vi.fn();
    const { container } = render(<Harness onMoveNote={onMove} initialExpanded={['sub']} />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByRole('button', { name: 'inner' }), { dataTransfer: dt });
    fireEvent.drop(container.querySelector('.filetree')!, { dataTransfer: dt });
    expect(onMove).toHaveBeenCalledWith('sub/inner.md', '');
  });

  it('ignores a drop into the note\'s own folder', () => {
    const onMove = vi.fn();
    render(<Harness onMoveNote={onMove} initialExpanded={['sub']} />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByRole('button', { name: 'inner' }), { dataTransfer: dt });
    fireEvent.drop(screen.getByRole('button', { name: /sub/ }), { dataTransfer: dt });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('expands a collapsed folder while a note hovers over it', () => {
    vi.useFakeTimers();
    try {
      render(<Harness onMoveNote={() => {}} />);
      const dt = fakeDataTransfer();
      fireEvent.dragStart(screen.getByRole('button', { name: 'a' }), { dataTransfer: dt });
      fireEvent.dragOver(screen.getByRole('button', { name: /sub/ }), { dataTransfer: dt });
      expect(screen.queryByRole('button', { name: 'inner' })).toBeNull();
      act(() => { vi.advanceTimersByTime(600); });
      expect(screen.getByRole('button', { name: 'inner' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not draggable without an onMoveNote handler', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'a' }).getAttribute('draggable')).not.toBe('true');
  });
});

describe('collectFolderPaths', () => {
  it('collects every folder path, skipping the unnamed root', () => {
    expect(collectFolderPaths(fixture)).toEqual(['sub']);
  });
});
