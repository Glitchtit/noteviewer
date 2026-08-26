import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RightPanel } from '../src/components/RightPanel';

describe('RightPanel', () => {
  it('lists backlinks and outline, wiring both callbacks', () => {
    const onOpen = vi.fn();
    const onJump = vi.fn();
    render(
      <RightPanel
        backlinks={['a.md', 'sub/b.md']}
        headings={[
          { level: 1, text: 'Top' },
          { level: 2, text: 'Sub' },
        ]}
        onOpenNote={onOpen}
        onJumpToHeading={onJump}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'sub/b.md' }));
    expect(onOpen).toHaveBeenCalledWith('sub/b.md');
    fireEvent.click(screen.getByRole('button', { name: 'Sub' }));
    expect(onJump).toHaveBeenCalledWith({ level: 2, text: 'Sub' });
  });
});
