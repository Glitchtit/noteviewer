import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '@noteviewer/shared';
import { ReadingView } from '../src/components/ReadingView';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"></svg>' }),
  },
}));

const tree: TreeNode = {
  name: '', path: '', type: 'folder',
  children: [{ name: 'Other.md', path: 'Other.md', type: 'note' }],
};

describe('ReadingView', () => {
  it('renders markdown and navigates wikilinks', async () => {
    const onOpen = vi.fn();
    render(<ReadingView content={'# Hi\n\nGo to [[Other]].'} tree={tree} onOpenNote={onOpen} />);
    await waitFor(() => expect(screen.getByText('Other')).toBeTruthy());
    fireEvent.click(screen.getByText('Other'));
    expect(onOpen).toHaveBeenCalledWith('Other.md');
  });

  it('renders mermaid blocks to SVG', async () => {
    render(
      <ReadingView content={'```mermaid\ngraph TD; A-->B;\n```'} tree={tree} onOpenNote={() => {}} />,
    );
    await waitFor(() => expect(document.querySelector('svg')).toBeTruthy());
  });

  describe('scroll memory', () => {
    beforeEach(() => localStorage.clear());

    it('restores the stored scroll position once content renders', async () => {
      localStorage.setItem('noteviewer.scroll', JSON.stringify({ 'read:a.md': 420 }));
      const { container } = render(<ReadingView content={'# Long'} tree={tree} scrollKey="a.md" />);
      const el = container.querySelector<HTMLElement>('.reading-view')!;
      await waitFor(() => expect(el.innerHTML).toContain('Long'));
      await waitFor(() => expect(el.scrollTop).toBe(420));
    });

    it('saves user scrolling but not programmatic restores', async () => {
      vi.useFakeTimers();
      try {
        const { container } = render(<ReadingView content={'# Long'} tree={tree} scrollKey="a.md" />);
        const el = container.querySelector<HTMLElement>('.reading-view')!;
        el.scrollTop = 99;
        fireEvent.scroll(el);
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(localStorage.getItem('noteviewer.scroll')).toBeNull();

        fireEvent.wheel(el);
        el.scrollTop = 300;
        fireEvent.scroll(el);
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(JSON.parse(localStorage.getItem('noteviewer.scroll')!)).toEqual({ 'read:a.md': 300 });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
