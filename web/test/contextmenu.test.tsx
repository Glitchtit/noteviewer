import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu } from '../src/components/ContextMenu';

describe('ContextMenu', () => {
  it('runs the chosen item and closes', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={[{ label: 'Open', onSelect }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it('asks for a second click on items with a confirmLabel', () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu
        x={0} y={0} onClose={() => {}}
        items={[{ label: 'Delete', confirmLabel: 'Really delete?', onSelect }]}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Really delete?' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('closes on Escape and on an outside pointer-down', () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={[{ label: 'Open', onSelect() {} }]} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Open' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
