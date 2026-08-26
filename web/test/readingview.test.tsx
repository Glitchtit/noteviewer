import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
});
