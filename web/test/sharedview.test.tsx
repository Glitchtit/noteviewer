import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedView } from '../src/components/SharedView';
import { api, ApiError } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return { ...actual, api: { ...actual.api, publicNote: vi.fn() } };
});

beforeEach(() => { vi.mocked(api.publicNote).mockReset(); });

describe('SharedView', () => {
  it('renders the shared note read-only with inert wikilinks and token-scoped embeds', async () => {
    vi.mocked(api.publicNote).mockResolvedValue({
      title: 'Agenda',
      content: '# Agenda\n\nSee [[Secret]].\n\n![[pic.png]]',
    });
    render(<SharedView token="tok" />);
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('Agenda'));
    await waitFor(() => expect(document.querySelector('img.internal-embed')?.getAttribute('src')).toBe(
      '/api/public/tok/embed/pic.png',
    ));
    expect(document.querySelector('.reading-view.inert-links')).toBeTruthy();
    expect(document.title).toBe('Agenda');
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });

  it('says so when the link is gone', async () => {
    vi.mocked(api.publicNote).mockRejectedValue(new ApiError(404, 'not found'));
    render(<SharedView token="gone" />);
    await screen.findByTestId('share-missing');
  });
});
