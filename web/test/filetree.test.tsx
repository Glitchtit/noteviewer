import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '@noteviewer/shared';
import { FileTree } from '../src/components/FileTree';

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

describe('FileTree', () => {
  it('renders notes without .md and calls onOpenNote', () => {
    const onOpen = vi.fn();
    render(<FileTree root={fixture} selected={null} onOpenNote={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onOpen).toHaveBeenCalledWith('a.md');
  });

  it('collapses and expands folders', () => {
    render(<FileTree root={fixture} selected={null} onOpenNote={() => {}} />);
    expect(screen.getByRole('button', { name: 'inner' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /sub/ }));
    expect(screen.queryByRole('button', { name: 'inner' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /sub/ }));
    expect(screen.getByRole('button', { name: 'inner' })).toBeTruthy();
  });

  it('links attachments to /api/file and marks the selected note', () => {
    render(<FileTree root={fixture} selected="a.md" onOpenNote={() => {}} />);
    const link = screen.getByRole('link', { name: 'img.png' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/file/img.png');
    expect(screen.getByRole('button', { name: 'a' }).className).toContain('selected');
  });
});
