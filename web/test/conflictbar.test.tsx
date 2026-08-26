import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConflictBar } from '../src/components/ConflictBar';

describe('ConflictBar', () => {
  it('offers exactly the three resolutions', () => {
    const theirs = vi.fn();
    const mine = vi.fn();
    const copy = vi.fn();
    render(<ConflictBar onTheirs={theirs} onMine={mine} onCopy={copy} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Load theirs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as copy' }));
    expect(theirs).toHaveBeenCalledOnce();
    expect(mine).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledOnce();
  });
});
