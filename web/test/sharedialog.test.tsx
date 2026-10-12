import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareDialog } from '../src/components/ShareDialog';
import { api, ApiError } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      shares: vi.fn(),
      createShare: vi.fn(),
      revokeShare: vi.fn(),
      emailStatus: vi.fn(),
      email: vi.fn(),
      emails: vi.fn(),
    },
  };
});

const existing = {
  token: 'tok1', path: 'a.md', createdAt: '2026-10-01T00:00:00Z', expiresAt: null,
  url: 'https://share.example.com/s/tok1',
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.shares).mockReset().mockResolvedValue([existing]);
  vi.mocked(api.createShare).mockReset();
  vi.mocked(api.revokeShare).mockReset().mockResolvedValue({ revoked: true });
  vi.mocked(api.emailStatus).mockReset().mockResolvedValue({ configured: true, from: 'bot@example.com' });
  vi.mocked(api.email).mockReset().mockResolvedValue({ sent: true });
  vi.mocked(api.emails).mockReset().mockResolvedValue([]);
});

describe('ShareDialog links', () => {
  it('lists, creates (with expiry) and revokes links', async () => {
    vi.mocked(api.createShare).mockResolvedValue({
      ...existing, token: 'tok2', url: '/s/tok2', expiresAt: '2026-10-08T00:00:00Z',
    });
    render(<ShareDialog path="a.md" title="A" onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('share-link')).toHaveLength(1));
    expect(screen.getByDisplayValue('https://share.example.com/s/tok1')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Link expiry'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(screen.getAllByTestId('share-link')).toHaveLength(2));
    expect(api.createShare).toHaveBeenCalledWith('a.md', 7);
    // relative URLs (no PUBLIC_SHARE_URL) are shown absolute
    expect(screen.getByDisplayValue(`${window.location.origin}/s/tok2`)).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    await waitFor(() => expect(screen.getAllByTestId('share-link')).toHaveLength(1));
    expect(api.revokeShare).toHaveBeenCalledWith('tok1');
  });
});

describe('ShareDialog email', () => {
  it('sends to comma-separated recipients with the title as default subject', async () => {
    render(<ShareDialog path="a.md" title="Agenda" onClose={() => {}} />);
    await screen.findByText('from bot@example.com');
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'x@example.com, y@example.com' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hej' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send PDF' }));
    await screen.findByText('Sent to x@example.com, y@example.com.');
    expect(api.email).toHaveBeenCalledWith({
      path: 'a.md', to: ['x@example.com', 'y@example.com'], subject: 'Agenda', message: 'Hej',
    });
  });

  it('suggests addresses from the note and from earlier sends', async () => {
    localStorage.setItem('noteviewer.share.recent', JSON.stringify(['boss@firma.se']));
    render(<ShareDialog path="a.md" title="A" content={'**E-post:** Andreas.fagerstrom@fcg.fi'} onClose={() => {}} />);
    await screen.findByText('from bot@example.com');
    fireEvent.focus(screen.getByLabelText('To'));
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Andreas.fagerstrom@fcg.fiin note',
      'boss@firma.serecent',
    ]);
    fireEvent.mouseDown(screen.getByRole('option', { name: /fcg\.fi/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send PDF' }));
    await screen.findByText('Sent to Andreas.fagerstrom@fcg.fi.');
    expect(JSON.parse(localStorage.getItem('noteviewer.share.recent')!)).toEqual(['Andreas.fagerstrom@fcg.fi', 'boss@firma.se']);
    expect(screen.queryAllByTestId('recipient-pill')).toEqual([]);
  });

  it('suggests addresses from the whole vault after the note, labelled with their note', async () => {
    localStorage.setItem('noteviewer.share.recent', JSON.stringify(['boss@firma.se', 'kalle@kund.fi']));
    vi.mocked(api.emails).mockResolvedValue([
      { email: 'andreas.fagerstrom@FCG.fi', notes: [{ path: 'Kontakter/Andreas.md', title: 'Andreas Fagerström' }] },
      {
        email: 'kalle@kund.fi',
        notes: [
          { path: 'Kunder/Acme.md', title: 'Acme' },
          { path: 'Möten/Vecka 3.md', title: 'Vecka 3' },
        ],
      },
    ]);
    render(<ShareDialog path="a.md" title="A" content="Andreas.fagerstrom@fcg.fi" onClose={() => {}} />);
    await screen.findByText('from bot@example.com');
    fireEvent.focus(screen.getByLabelText('To'));
    await waitFor(() =>
      expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Andreas.fagerstrom@fcg.fiin note',
        'kalle@kund.fiAcme +1',
        'boss@firma.serecent',
      ]),
    );
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'vecka' } });
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['kalle@kund.fiAcme +1']);
  });

  it('still works when the address book cannot be loaded', async () => {
    vi.mocked(api.emails).mockRejectedValue(new Error('offline'));
    render(<ShareDialog path="a.md" title="A" content="x@y.fi" onClose={() => {}} />);
    await screen.findByText('from bot@example.com');
    fireEvent.focus(screen.getByLabelText('To'));
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
  });

  it('refuses to send while an address is invalid', async () => {
    render(<ShareDialog path="a.md" title="A" onClose={() => {}} />);
    await screen.findByText('from bot@example.com');
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'andreas@fcg, ok@x.fi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send PDF' }));
    expect(await screen.findByText(/andreas@fcg is not a valid address/)).toBeTruthy();
    expect(api.email).not.toHaveBeenCalled();
  });

  it('asks for a recipient instead of sending to nobody', async () => {
    render(<ShareDialog path="a.md" title="A" onClose={() => {}} />);
    await screen.findByText('from bot@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send PDF' }));
    expect(await screen.findByText('Add at least one recipient.')).toBeTruthy();
    expect(api.email).not.toHaveBeenCalled();
  });

  it('closes the suggestion list on Escape without closing the dialog', async () => {
    const onClose = vi.fn();
    render(<ShareDialog path="a.md" title="A" content="a@x.fi" onClose={onClose} />);
    await screen.findByText('from bot@example.com');
    fireEvent.focus(screen.getByLabelText('To'));
    fireEvent.keyDown(screen.getByLabelText('To'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the server error when sending fails', async () => {
    vi.mocked(api.email).mockRejectedValue(new ApiError(502, 'x', { error: 'Sending failed: auth failed' }));
    render(<ShareDialog path="a.md" title="A" onClose={() => {}} />);
    await screen.findByText('from bot@example.com');
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'x@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send PDF' }));
    await screen.findByText('Sending failed: auth failed');
  });

  it('explains when SMTP is not configured', async () => {
    vi.mocked(api.emailStatus).mockResolvedValue({ configured: false, from: null });
    render(<ShareDialog path="a.md" title="A" onClose={() => {}} />);
    await screen.findByText(/Email isn’t set up on the server/);
    expect(screen.queryByRole('button', { name: 'Send PDF' })).toBeNull();
  });

  it('offers a PDF download and closes on Escape', async () => {
    const onClose = vi.fn();
    render(<ShareDialog path="DIFF/Möte.md" title="A" onClose={onClose} />);
    expect(screen.getByText('Download PDF').getAttribute('href')).toBe('/api/pdf/DIFF/M%C3%B6te.md');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
