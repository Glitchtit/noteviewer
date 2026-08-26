import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNoteEditor } from '../src/hooks/useNoteEditor';
import { api, ApiError } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      tree: vi.fn(),
      note: vi.fn(),
      save: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      search: vi.fn(),
    },
  };
});

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function noteResponse(content: string, hash: string, title = 'T') {
  return {
    content,
    backlinks: ['ref.md'],
    meta: { path: 'a.md', title, tags: [], links: [], headings: [], mtimeMs: 1, hash },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(mocked).forEach((fn) => fn.mockReset());
});
afterEach(() => {
  vi.useRealTimers();
});

async function openNote(hash = 'h1', content = 'body') {
  mocked.note!.mockResolvedValue(noteResponse(content, hash));
  const hook = renderHook(() => useNoteEditor());
  await act(() => hook.result.current.open('a.md'));
  return hook;
}

describe('useNoteEditor', () => {
  it('open loads content, hash, backlinks', async () => {
    const { result } = await openNote();
    expect(result.current.state.path).toBe('a.md');
    expect(result.current.state.content).toBe('body');
    expect(result.current.state.dirty).toBe(false);
    expect(result.current.state.backlinks).toEqual(['ref.md']);
  });

  it('autosaves 1000ms after the last change with the base hash', async () => {
    const { result } = await openNote();
    mocked.save!.mockResolvedValue({ mtimeMs: 2, hash: 'h2' });
    act(() => result.current.handleChange('body edited'));
    expect(result.current.state.dirty).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(mocked.save).toHaveBeenCalledWith('a.md', 'body edited', 'h1');
    expect(result.current.state.dirty).toBe(false);
  });

  it('sets conflict on 409 and stops autosaving', async () => {
    const { result } = await openNote();
    mocked.save!.mockRejectedValue(
      new ApiError(409, 'conflict', { current: { content: 'disk', mtimeMs: 3, hash: 'hd' } }),
    );
    act(() => result.current.handleChange('mine'));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.state.conflict?.content).toBe('disk');
    mocked.save!.mockClear();
    await act(() => result.current.saveNow());
    expect(mocked.save).not.toHaveBeenCalled();
  });

  it('keeps dirty and retries on network error', async () => {
    const { result } = await openNote();
    mocked.save!.mockRejectedValueOnce(new ApiError(0, 'network error'));
    mocked.save!.mockResolvedValueOnce({ mtimeMs: 2, hash: 'h2' });
    act(() => result.current.handleChange('x'));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.state.dirty).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.state.dirty).toBe(false);
    expect(mocked.save).toHaveBeenCalledTimes(2);
  });

  it('external with same hash is an echo: buffer untouched', async () => {
    const { result } = await openNote('h1', 'body');
    const before = result.current.state.revision;
    mocked.note!.mockResolvedValue(noteResponse('body', 'h1', 'New Title'));
    await act(() => result.current.external('a.md'));
    expect(result.current.state.revision).toBe(before);
    expect(result.current.state.title).toBe('New Title');
  });

  it('external on clean buffer reloads content and bumps revision', async () => {
    const { result } = await openNote('h1', 'body');
    const before = result.current.state.revision;
    mocked.note!.mockResolvedValue(noteResponse('from disk', 'h9'));
    await act(() => result.current.external('a.md'));
    expect(result.current.state.content).toBe('from disk');
    expect(result.current.state.revision).toBe(before + 1);
  });

  it('external on dirty buffer sets conflict', async () => {
    const { result } = await openNote();
    act(() => result.current.handleChange('mine'));
    mocked.note!.mockResolvedValue(noteResponse('theirs', 'h9'));
    await act(() => result.current.external('a.md'));
    expect(result.current.state.conflict?.content).toBe('theirs');
    expect(result.current.state.dirty).toBe(true);
  });

  it('keepTheirs applies disk content; keepMine saves with conflict hash', async () => {
    const { result } = await openNote();
    act(() => result.current.handleChange('mine'));
    mocked.note!.mockResolvedValue(noteResponse('theirs', 'h9'));
    await act(() => result.current.external('a.md'));
    act(() => result.current.keepTheirs());
    expect(result.current.state.content).toBe('theirs');
    expect(result.current.state.conflict).toBeNull();
    expect(result.current.state.dirty).toBe(false);
  });

  it('keepMine overwrites using the conflict hash as base', async () => {
    const { result } = await openNote();
    act(() => result.current.handleChange('mine'));
    mocked.note!.mockResolvedValue(noteResponse('theirs', 'h9'));
    await act(() => result.current.external('a.md'));
    mocked.save!.mockResolvedValue({ mtimeMs: 5, hash: 'h10' });
    await act(() => result.current.keepMine());
    expect(mocked.save).toHaveBeenCalledWith('a.md', 'mine', 'h9');
    expect(result.current.state.conflict).toBeNull();
    expect(result.current.state.dirty).toBe(false);
  });

  it('saveAsCopy creates a unique copy and switches to it', async () => {
    const { result } = await openNote();
    act(() => result.current.handleChange('mine'));
    mocked.note!.mockResolvedValue(noteResponse('theirs', 'h9'));
    await act(() => result.current.external('a.md'));
    mocked.create!.mockResolvedValue({ path: 'a-copy.md', mtimeMs: 6, hash: 'hc' });
    await act(() => result.current.saveAsCopy());
    expect(mocked.create).toHaveBeenCalledWith('a.md', 'mine', true);
    expect(result.current.state.path).toBe('a-copy.md');
    expect(result.current.state.title).toBe('a-copy');
    expect(result.current.state.conflict).toBeNull();
    expect(result.current.state.dirty).toBe(false);
  });

  it('open flushes a pending dirty save first', async () => {
    const { result } = await openNote();
    mocked.save!.mockResolvedValue({ mtimeMs: 2, hash: 'h2' });
    act(() => result.current.handleChange('unsaved'));
    mocked.note!.mockResolvedValue({
      content: 'other', backlinks: [],
      meta: { path: 'b.md', title: 'B', tags: [], links: [], headings: [], mtimeMs: 1, hash: 'hb' },
    });
    await act(() => result.current.open('b.md'));
    expect(mocked.save).toHaveBeenCalledWith('a.md', 'unsaved', 'h1');
    expect(result.current.state.path).toBe('b.md');
  });
});
