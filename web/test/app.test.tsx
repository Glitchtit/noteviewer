import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api } from '../src/api';

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

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const tree = {
  name: '', path: '', type: 'folder' as const,
  children: [{ name: 'a.md', path: 'a.md', type: 'note' as const }],
};

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
});
