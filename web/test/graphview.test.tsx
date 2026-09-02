import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphData } from '@noteviewer/shared';
import { GraphView } from '../src/components/GraphView';
import { api } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return { ...actual, api: { graph: vi.fn() } };
});

const mocked = api as unknown as { graph: ReturnType<typeof vi.fn> };

// jsdom has no 2D canvas; a permissive stub lets the draw loop run.
const ctxStub = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
  set: () => true,
});

function node(id: string, extra: Partial<GraphData['nodes'][number]> = {}) {
  return { id, title: id.replace(/\.md$/, ''), tags: [], unresolved: false, inbound: 0, outbound: 0, ...extra };
}

const graph: GraphData = {
  nodes: [
    node('a.md', { tags: ['project'] }),
    node('b.md'),
    node('sub/c.md', { title: 'C note' }),
    node('lonely.md'),
    node('Ghost', { unresolved: true }),
  ],
  edges: [
    { source: 'a.md', target: 'b.md' },
    { source: 'b.md', target: 'sub/c.md' },
    { source: 'a.md', target: 'Ghost' },
  ],
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctxStub as unknown as CanvasRenderingContext2D);
  mocked.graph.mockReset();
  mocked.graph.mockResolvedValue(graph);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GraphView', () => {
  it('fetches the graph and reports node and link counts', async () => {
    render(<GraphView currentPath={null} refreshKey={0} onOpenNote={() => {}} />);
    expect(screen.getByTestId('graph-status').textContent).toBe('Loading graph…');
    await waitFor(() => expect(screen.getByTestId('graph-status').textContent).toBe('5 notes · 3 links'));
    expect(mocked.graph).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('img', { name: 'Note graph' })).toBeTruthy();
  });

  it('shows an error when the fetch fails', async () => {
    mocked.graph.mockRejectedValue(new Error('boom'));
    render(<GraphView currentPath={null} refreshKey={0} onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('graph-status').textContent).toBe('Failed to load graph.'));
  });

  it('Enter in the filter opens the best match, preferring exact titles', async () => {
    const onOpen = vi.fn();
    render(<GraphView currentPath={null} refreshKey={0} onOpenNote={onOpen} />);
    await waitFor(() => expect(screen.getByTestId('graph-status').textContent).toContain('5 notes'));
    const input = screen.getByLabelText('Filter graph');
    fireEvent.change(input, { target: { value: 'c note' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('sub/c.md');
    // Substring match with no exact title: highest-degree match wins (a.md has degree 2).
    fireEvent.change(input, { target: { value: '.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith('a.md');
    // Tags are searchable too.
    fireEvent.change(input, { target: { value: 'project' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith('a.md');
  });

  it('activating an unresolved node asks to create it instead of opening', async () => {
    const onOpen = vi.fn();
    const onCreate = vi.fn();
    render(<GraphView currentPath={null} refreshKey={0} onOpenNote={onOpen} onCreateNote={onCreate} />);
    await waitFor(() => expect(screen.getByTestId('graph-status').textContent).toContain('5 notes'));
    const input = screen.getByLabelText('Filter graph');
    fireEvent.change(input, { target: { value: 'ghost' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('Ghost');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('toggles orphans and unresolved nodes', async () => {
    render(<GraphView currentPath={null} refreshKey={0} onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('graph-status').textContent).toBe('5 notes · 3 links'));
    fireEvent.click(screen.getByLabelText('Orphans'));
    expect(screen.getByTestId('graph-status').textContent).toBe('4 notes · 3 links');
    fireEvent.click(screen.getByLabelText('Unresolved'));
    expect(screen.getByTestId('graph-status').textContent).toBe('3 notes · 2 links');
  });

  it('offers a local graph around the current note with adjustable depth', async () => {
    render(<GraphView currentPath="a.md" refreshKey={0} onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('graph-status').textContent).toBe('5 notes · 3 links'));
    fireEvent.click(screen.getByRole('button', { name: 'Local' }));
    expect(screen.getByRole('button', { name: 'Local' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('graph-status').textContent).toBe('3 notes · 2 links');
    fireEvent.change(screen.getByLabelText('Local graph depth'), { target: { value: '2' } });
    expect(screen.getByTestId('graph-status').textContent).toBe('4 notes · 3 links');
    fireEvent.click(screen.getByRole('button', { name: 'Global' }));
    expect(screen.getByTestId('graph-status').textContent).toBe('5 notes · 3 links');
  });

  it('hides the scope switch when no note is open', async () => {
    render(<GraphView currentPath={null} refreshKey={0} onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('graph-status').textContent).toContain('5 notes'));
    expect(screen.queryByRole('button', { name: 'Local' })).toBeNull();
  });

  it('refetches, debounced, when refreshKey changes', async () => {
    const { rerender } = render(<GraphView currentPath={null} refreshKey={0} onOpenNote={() => {}} />);
    await waitFor(() => expect(mocked.graph).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    rerender(<GraphView currentPath={null} refreshKey={1} onOpenNote={() => {}} />);
    rerender(<GraphView currentPath={null} refreshKey={2} onOpenNote={() => {}} />);
    expect(mocked.graph).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocked.graph).toHaveBeenCalledTimes(2);
  });

  it('pans and zooms without throwing and fits on demand', async () => {
    render(<GraphView currentPath={null} refreshKey={0} onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('graph-status').textContent).toContain('5 notes'));
    const canvas = screen.getByRole('img', { name: 'Note graph' });
    fireEvent.pointerDown(canvas, { button: 0, clientX: 5000, clientY: 5000, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 5020, clientY: 5010, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 5020, clientY: 5010, pointerId: 1 });
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('button', { name: 'Fit graph to view' }));
    fireEvent.pointerLeave(canvas);
    expect(screen.getByTestId('graph-status').textContent).toBe('5 notes · 3 links');
  });
});
