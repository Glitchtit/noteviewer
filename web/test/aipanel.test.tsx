import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AiSession, AiStatus, AiTurn } from '@noteviewer/shared';
import { AiPanel, type AiPanelProps } from '../src/components/AiPanel';
import { api } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      aiSessions: vi.fn(),
      aiCreateSession: vi.fn(),
      aiRun: vi.fn(),
      aiStop: vi.fn(),
      aiUndo: vi.fn(),
      aiDeleteSession: vi.fn(),
    },
  };
});

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(e: AgentEvent) {
    act(() => this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent));
  }
}

const enabled: AiStatus = { enabled: true, model: 'claude-opus-5-5', profileNote: 'AI Profile.md', profileExists: false, claudeMdExists: false };

function session(turns: AiTurn[] = [], running = false): AiSession {
  return {
    id: 's1', title: 'T', createdAt: '', updatedAt: '', model: 'claude-opus-5-5', running, turns,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function turn(over: Partial<AiTurn> = {}): AiTurn {
  return { id: 't1', prompt: 'Do it', context: { path: 'a.md' }, items: [], changes: [], status: 'done', startedAt: '', ...over };
}

function setup(overrides: Partial<AiPanelProps> = {}) {
  const props: AiPanelProps = {
    status: enabled,
    path: 'a.md',
    getSelection: () => '',
    saveNow: vi.fn(async () => {}),
    onOpenNote: vi.fn(),
    onOpenProfile: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<AiPanel {...props} />);
  return props;
}

const lastSource = () => FakeEventSource.instances.at(-1)!;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  localStorage.clear();
  mocked.aiSessions!.mockResolvedValue([]);
  mocked.aiCreateSession!.mockResolvedValue({ id: 's1' });
  mocked.aiRun!.mockResolvedValue({ turnId: 't1' });
  mocked.aiStop!.mockResolvedValue({ stopped: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const fn of Object.values(mocked)) if (typeof fn?.mockReset === 'function') fn.mockReset();
});

async function sendPrompt(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(mocked.aiRun).toHaveBeenCalled());
}

describe('AiPanel', () => {
  it('explains how to enable the agent when the server has no key', () => {
    setup({ status: { ...enabled, enabled: false } });
    expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('saves the note, creates a session and starts a run with the context', async () => {
    const order: string[] = [];
    const props = setup({ getSelection: () => 'picked', saveNow: vi.fn(async () => void order.push('save')) });
    mocked.aiRun!.mockImplementation(async () => {
      order.push('run');
      return { turnId: 't1' };
    });
    await sendPrompt('Fix the typos');
    expect(props.saveNow).toHaveBeenCalled();
    expect(order).toEqual(['save', 'run']);
    expect(mocked.aiCreateSession).toHaveBeenCalled();
    expect(mocked.aiRun).toHaveBeenCalledWith('s1', { prompt: 'Fix the typos', path: 'a.md', selection: 'picked' });
    await waitFor(() => expect(lastSource().url).toBe('/api/ai/sessions/s1/events'));
  });

  it('renders streamed text, thinking and tool rows', async () => {
    setup();
    await sendPrompt('go');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const es = lastSource();
    es.emit({ type: 'snapshot', session: session([turn({ status: 'running' })], true) });
    es.emit({ type: 'thinking_delta', turnId: 't1', itemId: '1.0', text: 'pondering' });
    es.emit({ type: 'tool_start', turnId: 't1', itemId: 't:x', name: 'edit', input: { path: 'a.md' } });
    es.emit({ type: 'tool_end', turnId: 't1', itemId: 't:x', summary: 'Edited a.md (+1 −1)', detail: '-a\n+b', isError: false });
    es.emit({ type: 'text_delta', turnId: 't1', itemId: '2.0', text: 'All **done**' });
    expect(await screen.findByText('Edited a.md (+1 −1)')).toBeTruthy();
    expect(screen.getByText('Thinking')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('done').tagName).toBe('STRONG'));
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });

  it('opens [[wikilinks]] in answers', async () => {
    const props = setup();
    await sendPrompt('go');
    lastSource().emit({ type: 'snapshot', session: session([turn({ items: [{ id: '1', kind: 'text', text: 'See [[Plan]]' }] })]) });
    fireEvent.click(await screen.findByText('Plan'));
    expect(props.onOpenNote).toHaveBeenCalledWith('Plan');
  });

  it('sends a quick action as a preset prompt', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Tidy up' }));
    await waitFor(() => expect(mocked.aiRun).toHaveBeenCalled());
    const body = mocked.aiRun!.mock.calls[0]![1] as { prompt: string; path: string };
    expect(body.prompt).toMatch(/^Tidy up the open note/);
    expect(body.path).toBe('a.md');
  });

  it('disables quick actions without an open note', () => {
    setup({ path: null });
    expect((screen.getByRole('button', { name: 'Tidy up' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('stops a running turn', async () => {
    setup();
    await sendPrompt('go');
    lastSource().emit({ type: 'snapshot', session: session([turn({ status: 'running' })], true) });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(mocked.aiStop).toHaveBeenCalledWith('s1');
  });

  it('undoes a change and resolves a conflict as a copy', async () => {
    setup();
    await sendPrompt('go');
    const changes = [
      { id: 'c1', op: 'edit' as const, path: 'a.md', before: 'x', afterHash: 'h', added: 1, removed: 1 },
      { id: 'c2', op: 'create' as const, path: 'b.md', before: null, afterHash: 'h2', added: 3, removed: 0 },
    ];
    lastSource().emit({ type: 'snapshot', session: session([turn({ changes })]) });
    expect(await screen.findByText('Changed 2 files')).toBeTruthy();
    mocked.aiUndo!.mockResolvedValueOnce({ results: [{ id: 'c1', status: 'conflict', message: 'a.md was edited after the agent changed it' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Undo a.md' }));
    await waitFor(() => expect(mocked.aiUndo).toHaveBeenCalledWith('s1', 't1', { changeIds: ['c1'] }));
    expect(await screen.findByText(/was edited after/)).toBeTruthy();
    mocked.aiUndo!.mockResolvedValueOnce({ results: [{ id: 'c1', status: 'copied', copyPath: 'a-copy.md' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Restore as copy' }));
    await waitFor(() => expect(mocked.aiUndo).toHaveBeenLastCalledWith('s1', 't1', { changeIds: ['c1'], resolution: 'copy' }));
    expect(await screen.findByText(/a-copy\.md/)).toBeTruthy();
  });

  it('undoes everything in a turn', async () => {
    setup();
    await sendPrompt('go');
    const changes = [{ id: 'c1', op: 'create' as const, path: 'b.md', before: null, afterHash: 'h', added: 1, removed: 0 }];
    lastSource().emit({ type: 'snapshot', session: session([turn({ changes })]) });
    mocked.aiUndo!.mockResolvedValueOnce({ results: [{ id: 'c1', status: 'undone' }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Undo all' }));
    await waitFor(() => expect(mocked.aiUndo).toHaveBeenCalledWith('s1', 't1', {}));
  });

  it('starts a new session', async () => {
    setup();
    await sendPrompt('go');
    lastSource().emit({ type: 'snapshot', session: session([turn({ items: [{ id: '1', kind: 'text', text: 'old answer' }] })]) });
    expect(await screen.findByText('old answer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    await waitFor(() => expect(screen.queryByText('old answer')).toBeNull());
    expect(lastSource().closed).toBe(true);
  });

  it('reopens the last used session', async () => {
    localStorage.setItem('noteviewer.ai.session', 's1');
    mocked.aiSessions!.mockResolvedValue([{ id: 's1', title: 'Earlier', updatedAt: '', running: false }]);
    setup();
    await waitFor(() => expect(lastSource()?.url).toBe('/api/ai/sessions/s1/events'));
  });

  it('shows run errors', async () => {
    setup();
    await sendPrompt('go');
    lastSource().emit({ type: 'snapshot', session: session([turn({ status: 'error', error: 'Invalid ANTHROPIC_API_KEY' })]) });
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid ANTHROPIC_API_KEY');
  });
});
