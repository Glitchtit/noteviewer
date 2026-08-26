import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchOverlay } from '../src/components/SearchOverlay';
import { api } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return { ...actual, api: { ...actual.api, search: vi.fn() } };
});

const paths = ['Daily/2026-08-26.md', 'Projects/Noteviewer.md', 'Inbox.md'];

beforeEach(() => vi.mocked(api.search).mockReset());

describe('SearchOverlay switcher', () => {
  it('fuzzy filters and opens on Enter', () => {
    const onOpen = vi.fn();
    render(<SearchOverlay mode="switcher" notePaths={paths} onOpen={onOpen} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'notev' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('Projects/Noteviewer.md');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<SearchOverlay mode="switcher" notePaths={paths} onOpen={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SearchOverlay search', () => {
  it('debounces api.search and lists results', async () => {
    vi.useFakeTimers();
    vi.mocked(api.search).mockResolvedValue([{ path: 'Inbox.md', title: 'Inbox', score: 1 }]);
    render(<SearchOverlay mode="search" notePaths={[]} onOpen={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'inbox' } });
    expect(api.search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(api.search).toHaveBeenCalledWith('inbox');
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText('Inbox')).toBeTruthy());
  });

  it('ignores a stale response that resolves after a newer query', async () => {
    vi.useFakeTimers();
    let resolveA!: (v: { path: string; title: string; score: number }[]) => void;
    let resolveAb!: (v: { path: string; title: string; score: number }[]) => void;
    const pendingA = new Promise<{ path: string; title: string; score: number }[]>((res) => {
      resolveA = res;
    });
    const pendingAb = new Promise<{ path: string; title: string; score: number }[]>((res) => {
      resolveAb = res;
    });
    vi.mocked(api.search).mockImplementationOnce(() => pendingA).mockImplementationOnce(() => pendingAb);

    render(<SearchOverlay mode="search" notePaths={[]} onOpen={() => {}} onClose={() => {}} />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'a' } });
    await vi.advanceTimersByTimeAsync(250);
    expect(api.search).toHaveBeenNthCalledWith(1, 'a');

    fireEvent.change(input, { target: { value: 'ab' } });
    await vi.advanceTimersByTimeAsync(250);
    expect(api.search).toHaveBeenNthCalledWith(2, 'ab');

    // Newer request ("ab") resolves first, then the stale "a" request resolves late.
    resolveAb([{ path: 'AB.md', title: 'AB', score: 1 }]);
    await pendingAb;
    resolveA([{ path: 'A.md', title: 'A', score: 1 }]);
    await pendingA;

    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText('AB')).toBeTruthy());
    expect(screen.queryByText('A')).toBeNull();
  });
});
