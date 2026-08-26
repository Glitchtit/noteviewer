import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api, ApiError } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      tree: vi.fn(), note: vi.fn(), save: vi.fn(), create: vi.fn(),
      remove: vi.fn(), rename: vi.fn(), search: vi.fn(),
    },
  };
});

vi.mock('../src/components/EditorPane', () => ({
  EditorPane: ({ onChange }: { onChange(text: string): void }) => (
    <button data-testid="mock-editor-change" onClick={() => onChange('edited')}>
      mock editor
    </button>
  ),
}));

vi.mock('../src/components/ReadingView', () => ({
  ReadingView: ({ content }: { content: string }) => (
    <div data-testid="mock-reading-view">{content}</div>
  ),
}));

vi.mock('../src/components/KanbanBoard', () => ({
  KanbanBoard: ({ content, onChange }: { content: string; onChange(md: string): void }) => (
    <div data-testid="mock-kanban-board">
      <span data-testid="mock-kanban-content">{content}</span>
      <button
        data-testid="mock-kanban-change"
        onClick={() => onChange('---\nkanban-plugin: board\n---\n\n## Todo\n\n- [x] task one\n')}
      >
        change
      </button>
    </div>
  ),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const tree = {
  name: '', path: '', type: 'folder' as const,
  children: [
    { name: 'a.md', path: 'a.md', type: 'note' as const },
    { name: 'b.md', path: 'b.md', type: 'note' as const },
  ],
};

const KANBAN_CONTENT = '---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] task one\n';

function noteResponse(path: string, content: string) {
  return {
    content, backlinks: [],
    meta: { path, title: path.replace('.md', ''), tags: [], links: [], headings: [], mtimeMs: 1, hash: 'h1' },
  };
}

beforeEach(() => {
  Object.values(mocked).forEach((fn) => fn.mockReset());
  mocked.tree!.mockResolvedValue(tree);
});

describe('App', () => {
  it('loads the tree and opens a note', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', '# A note'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));
    expect(mocked.note).toHaveBeenCalledWith('a.md');
  });

  it('creates a note through the inline input', async () => {
    mocked.create!.mockResolvedValue({ path: 'new.md', mtimeMs: 1, hash: 'h' });
    mocked.note!.mockResolvedValue(noteResponse('new.md', ''));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New' }));
    const input = screen.getByPlaceholderText('path/note.md');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(mocked.create).toHaveBeenCalledWith('new.md'));
    await waitFor(() => expect(mocked.note).toHaveBeenCalledWith('new.md'));
  });

  it('deletes only after the two-click confirm', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', 'x'));
    mocked.remove!.mockResolvedValue({ trashedTo: '.trash/a.md' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mocked.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Really delete?' }));
    await waitFor(() => expect(mocked.remove).toHaveBeenCalledWith('a.md'));
  });

  it('renames via the inline input', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', 'x'));
    mocked.rename!.mockResolvedValue({ rewritten: [] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByPlaceholderText('path/note.md') as HTMLInputElement;
    expect(input.value).toBe('a.md');
    fireEvent.change(input, { target: { value: 'b.md' } });
    mocked.note!.mockResolvedValue(noteResponse('b.md', 'x'));
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(mocked.rename).toHaveBeenCalledWith('a.md', 'b.md'));
  });

  it('flushes a dirty save before renaming, using the old path', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', 'x'));
    mocked.save!.mockResolvedValue({ mtimeMs: 2, hash: 'h2' });
    mocked.rename!.mockResolvedValue({ rewritten: [] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));

    fireEvent.click(screen.getByTestId('mock-editor-change'));

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByPlaceholderText('path/note.md') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'b.md' } });
    mocked.note!.mockResolvedValue(noteResponse('b.md', 'x'));
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(mocked.rename).toHaveBeenCalledWith('a.md', 'b.md'));
    expect(mocked.save).toHaveBeenCalledWith('a.md', 'edited', 'h1');
    expect(mocked.save!.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.rename!.mock.invocationCallOrder[0]!,
    );
  });

  it('reading mode shows the live edit buffer, not the stale loaded snapshot', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', 'original'));
    mocked.save!.mockResolvedValue({ mtimeMs: 2, hash: 'h2' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));

    fireEvent.click(screen.getByTestId('mock-editor-change'));

    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading mode' }));

    await waitFor(() => expect(screen.getByTestId('mock-reading-view').textContent).toBe('edited'));
  });

  it('shows error when create fails with 409', async () => {
    mocked.create!.mockRejectedValue(new ApiError(409, 'conflict'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New' }));
    const input = screen.getByPlaceholderText('path/note.md');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByTestId('action-error')).toBeTruthy());
    expect(screen.getByTestId('action-error').textContent).toBe('A note with that name already exists.');
    expect(input).toBeTruthy();
  });

  it('shows error when delete fails', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', 'x'));
    mocked.remove!.mockRejectedValue(new ApiError(500, 'boom'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Really delete?' }));
    await waitFor(() => expect(screen.getByTestId('action-error')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('a kanban note opens directly in board mode, with no board toggle for plain notes', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', 'plain note'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));
    expect(screen.queryByTestId('mock-kanban-board')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Toggle board view' })).toBeNull();

    mocked.note!.mockResolvedValue(noteResponse('b.md', KANBAN_CONTENT));
    fireEvent.click(screen.getByRole('button', { name: 'b' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('b'));
    expect(screen.getByTestId('mock-kanban-board')).toBeTruthy();
    expect(screen.queryByTestId('mock-editor-change')).toBeNull();
    expect(screen.getByRole('button', { name: 'Toggle board view' })).toBeTruthy();
  });

  it('the board toggle switches a kanban note between board and raw editor', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', KANBAN_CONTENT));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('mock-kanban-board')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Toggle board view' }));
    expect(screen.queryByTestId('mock-kanban-board')).toBeNull();
    expect(screen.getByTestId('mock-editor-change')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle board view' }));
    expect(screen.getByTestId('mock-kanban-board')).toBeTruthy();
  });

  it('boardMode resets to true when the path changes', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', KANBAN_CONTENT));
    mocked.rename!.mockResolvedValue({ rewritten: [] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('mock-kanban-board')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Toggle board view' }));
    expect(screen.queryByTestId('mock-kanban-board')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByPlaceholderText('path/note.md') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'b.md' } });
    mocked.note!.mockResolvedValue(noteResponse('b.md', KANBAN_CONTENT));
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('b'));
    expect(screen.getByTestId('mock-kanban-board')).toBeTruthy();
  });

  it('board edits write through editor.applyLocalContent, marking the note dirty', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', KANBAN_CONTENT));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('mock-kanban-board')).toBeTruthy());

    fireEvent.click(screen.getByTestId('mock-kanban-change'));

    expect(screen.getByTestId('mock-kanban-content').textContent).toContain('- [x] task one');
    expect(screen.getByTestId('save-state').textContent).toBe('Edited');
  });
});
