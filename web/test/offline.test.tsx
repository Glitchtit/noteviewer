import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  let listener: (() => void) | null = null;
  return {
    ...actual,
    onNetworkError: (fn: (() => void) | null) => { listener = fn; },
    fireNetworkError: () => listener?.(),
    api: {
      tree: vi.fn(), note: vi.fn(), save: vi.fn(), create: vi.fn(),
      remove: vi.fn(), rename: vi.fn(), search: vi.fn(),
    },
  };
});

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const emptyTree = { name: '', path: '', type: 'folder' as const, children: [] };

beforeEach(() => {
  Object.values(mocked).forEach((fn) => fn.mockReset());
  mocked.tree!.mockResolvedValue(emptyTree);
});

describe('offline banner', () => {
  it('appears on network error and clears when a retry ping succeeds', async () => {
    const mod = (await import('../src/api')) as unknown as { fireNetworkError(): void };
    await act(async () => {
      render(<App />);
    });
    vi.useFakeTimers();
    act(() => mod.fireNetworkError());
    expect(screen.getByText(/Vault unreachable/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.queryByText(/Vault unreachable/)).toBeNull();
    vi.useRealTimers();
  });
});

describe('mobile drawer', () => {
  it('toggles the sidebar-open class', async () => {
    const { container } = render(<App />);
    const appDiv = container.querySelector('.app')!;
    expect(appDiv.className).not.toContain('sidebar-open');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(appDiv.className).toContain('sidebar-open');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(appDiv.className).not.toContain('sidebar-open');
  });
});
