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

  it('saveNow is not re-entrant while a save is already in flight', async () => {
    const { result } = await openNote();
    let resolveSave!: (value: { mtimeMs: number; hash: string }) => void;
    mocked.save!.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    act(() => result.current.handleChange('mine'));

    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.saveNow();
    });
    act(() => {
      p2 = result.current.saveNow();
    });
    // the second overlapping saveNow() must no-op: only one PUT in flight
    expect(mocked.save).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave({ mtimeMs: 2, hash: 'h2' });
      await p1;
      await p2;
    });
    expect(result.current.state.dirty).toBe(false);
  });

  it('keepMine does not corrupt a different note opened while its save is in flight', async () => {
    const { result } = await openNote(); // a.md, base hash h1
    act(() => result.current.handleChange('mine'));
    mocked.note!.mockResolvedValue(noteResponse('theirs', 'h9'));
    await act(() => result.current.external('a.md'));
    expect(result.current.state.conflict?.content).toBe('theirs');

    let resolveSave!: (value: { mtimeMs: number; hash: string }) => void;
    mocked.save!.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    let keepMinePromise!: Promise<void>;
    act(() => {
      keepMinePromise = result.current.keepMine();
    });
    expect(mocked.save).toHaveBeenCalledWith('a.md', 'mine', 'h9');

    // navigate away to b.md before the keepMine save resolves
    mocked.note!.mockResolvedValue({
      content: 'other', backlinks: [],
      meta: { path: 'b.md', title: 'B', tags: [], links: [], headings: [], mtimeMs: 1, hash: 'hb' },
    });
    await act(() => result.current.open('b.md'));
    expect(result.current.state.path).toBe('b.md');

    // now the stale a.md save resolves — it must not touch b.md's state
    await act(async () => {
      resolveSave({ mtimeMs: 5, hash: 'h10' });
      await keepMinePromise;
    });
    expect(result.current.state.path).toBe('b.md');
    expect(result.current.state.dirty).toBe(false);
    expect(result.current.state.conflict).toBeNull();

    // and it must not have clobbered b.md's base hash: a fresh autosave on
    // b.md should PUT with b.md's own base hash ('hb'), not the stale
    // conflict-resolution response ('h10')
    mocked.save!.mockClear();
    mocked.save!.mockResolvedValue({ mtimeMs: 6, hash: 'h11' });
    act(() => result.current.handleChange('bbb'));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(mocked.save).toHaveBeenCalledWith('b.md', 'bbb', 'hb');
  });

  it('open waits for an in-flight autosave before loading the next note', async () => {
    const { result } = await openNote(); // a.md, base hash h1
    let resolveSave!: (value: { mtimeMs: number; hash: string }) => void;
    mocked.save!.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    act(() => result.current.handleChange('mine'));
    await act(() => vi.advanceTimersByTimeAsync(1000)); // fires the autosave; save() is now in flight
    expect(mocked.save).toHaveBeenCalledWith('a.md', 'mine', 'h1');
    expect(result.current.state.saving).toBe(true);

    mocked.note!.mockClear();
    mocked.note!.mockResolvedValue({
      content: 'other', backlinks: [],
      meta: { path: 'b.md', title: 'B', tags: [], links: [], headings: [], mtimeMs: 1, hash: 'hb' },
    });

    const openPromise = result.current.open('b.md');

    // open() must block on the stale a.md save: it must not even fetch the
    // next note until that save settles, not merely race ahead of it
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocked.note).not.toHaveBeenCalled();
    expect(result.current.state.path).toBe('a.md');

    await act(async () => {
      resolveSave({ mtimeMs: 2, hash: 'h2' });
      await openPromise;
    });

    expect(mocked.note).toHaveBeenCalledWith('b.md');
    expect(result.current.state.path).toBe('b.md');
    expect(result.current.state.dirty).toBe(false);
    expect(result.current.state.conflict).toBeNull();

    // and b.md's base hash must be its own ('hb'), not clobbered by the
    // stale a.md save's response hash ('h2')
    mocked.save!.mockClear();
    mocked.save!.mockResolvedValue({ mtimeMs: 3, hash: 'h3' });
    act(() => result.current.handleChange('bbb'));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(mocked.save).toHaveBeenCalledWith('b.md', 'bbb', 'hb');
  });
});
