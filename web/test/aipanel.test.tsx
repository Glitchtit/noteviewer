import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiStatus } from '@noteviewer/shared';
import { AiPanel, type AiPanelProps } from '../src/components/AiPanel';
import { ApiError, streamAi } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return { ...actual, streamAi: vi.fn() };
});

const streamMock = streamAi as unknown as ReturnType<typeof vi.fn>;
const enabled: AiStatus = { enabled: true, model: 'gemini-x', profileNote: 'AI Profile.md', profileExists: false };

function setup(overrides: Partial<AiPanelProps> = {}) {
  const props: AiPanelProps = {
    status: enabled,
    path: 'a.md',
    getContent: () => 'note body',
    getSelection: () => '',
    onApply: vi.fn(),
    onOpenProfile: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<AiPanel {...props} />);
  return props;
}

afterEach(() => streamMock.mockReset());

describe('AiPanel', () => {
  it('explains how to enable AI when the server has no key', () => {
    setup({ status: { ...enabled, enabled: false } });
    expect(screen.getByText(/GEMINI_API_KEY/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Summarize' })).toBeNull();
  });

  it('runs a quick action on the note and applies the streamed result', async () => {
    streamMock.mockImplementation(async (_req, onText: (t: string) => void) => {
      onText('- [ ] call ');
      onText('Anna');
    });
    const props = setup({ getSelection: () => 'picked' });
    fireEvent.click(screen.getByRole('button', { name: 'Action items' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Append' })).toBeTruthy());
    expect(streamMock.mock.calls[0]![0]).toEqual({
      action: 'tasks', path: 'a.md', content: 'note body', selection: 'picked', prompt: undefined,
    });
    expect(screen.getByText('selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Append' }));
    expect(props.onApply).toHaveBeenCalledWith('append', '- [ ] call Anna');
    // only tidy offers replacement
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull();
  });

  it('sends earlier questions as chat history', async () => {
    streamMock.mockImplementation(async (_req, onText: (t: string) => void) => onText('answer'));
    setup();
    const box = screen.getByRole('textbox', { name: 'Question' });
    fireEvent.change(box, { target: { value: 'first?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('answer')).toBeTruthy());
    fireEvent.change(box, { target: { value: 'second?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(streamMock).toHaveBeenCalledTimes(2));
    expect(streamMock.mock.calls[1]![0]).toMatchObject({
      action: 'ask',
      prompt: 'second?',
      history: [{ role: 'user', text: 'first?' }, { role: 'model', text: 'answer' }],
    });
  });

  it('asks the vault when no note is open', async () => {
    streamMock.mockResolvedValue(undefined);
    setup({ path: null });
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'where?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(streamMock).toHaveBeenCalled());
    expect(streamMock.mock.calls[0]![0]).toEqual({ action: 'ask-vault', prompt: 'where?', history: [] });
  });

  it('shows server errors', async () => {
    streamMock.mockRejectedValue(new ApiError(502, 'API key not valid'));
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect((await screen.findByRole('alert')).textContent).toBe('API key not valid');
  });

  it('offers profile setup', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Set up profile' }));
    expect(props.onOpenProfile).toHaveBeenCalled();
  });
});
