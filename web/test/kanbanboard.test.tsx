import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from '../src/components/KanbanBoard';

const doc = '---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] task one\n\n## Done\n\n- [x] shipped\n';

describe('KanbanBoard', () => {
  it('renders columns and cards', () => {
    render(<KanbanBoard content={doc} onChange={() => {}} />);
    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('task one')).toBeTruthy();
    expect(screen.getByText('shipped')).toBeTruthy();
  });

  it('toggling a card checkbox writes updated markdown', () => {
    const onChange = vi.fn();
    render(<KanbanBoard content={doc} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0]![0]).toContain('- [x] task one');
  });

  it('adds a card via the column input', () => {
    const onChange = vi.fn();
    render(<KanbanBoard content={doc} onChange={onChange} />);
    const input = screen.getAllByPlaceholderText('Add card…')[0]!;
    fireEvent.change(input, { target: { value: 'new card' } });
    fireEvent.submit(input.closest('form')!);
    expect(onChange.mock.calls[0]![0]).toContain('- [ ] new card');
  });
});
