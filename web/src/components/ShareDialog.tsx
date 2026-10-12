import { useEffect, useMemo, useState } from 'react';
import type { ShareWithUrl } from '@noteviewer/shared';
import { api, ApiError } from '../api';
import { extractEmails, isValidEmail, parseRecipients, recentRecipients, rememberRecipients } from '../emails';
import { RecipientInput, type Suggestion } from './RecipientInput';

export interface ShareDialogProps {
  path: string;
  title: string;
  /** the note's text, scanned for email addresses to suggest */
  content?: string;
  onClose(): void;
}

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: 'Never expires', days: null },
  { label: 'Expires in 7 days', days: 7 },
  { label: 'Expires in 30 days', days: 30 },
];

function absolute(url: string): string {
  return new URL(url, window.location.origin).href;
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const msg = (err.body as { error?: string } | undefined)?.error;
    return msg ?? `${fallback} (${err.status}).`;
  }
  return fallback;
}

export function ShareDialog({ path, title, content = '', onClose }: ShareDialogProps) {
  const [shares, setShares] = useState<ShareWithUrl[]>([]);
  const [expiry, setExpiry] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [mail, setMail] = useState<{ configured: boolean; from: string | null } | null>(null);
  const [pills, setPills] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  // addresses in the note first, then ones emailed before
  const suggestions = useMemo<Suggestion[]>(() => {
    const inNote = extractEmails(content);
    const seen = new Set(inNote.map((e) => e.toLowerCase()));
    return [
      ...inNote.map((email) => ({ email, source: 'note' as const })),
      ...recentRecipients()
        .filter((e) => !seen.has(e.toLowerCase()))
        .map((email) => ({ email, source: 'recent' as const })),
    ];
  }, [content]);
  const [subject, setSubject] = useState(title);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [mailResult, setMailResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.shares(path).then(setShares, () => setLinkError('Could not load existing links.'));
    api.emailStatus().then(setMail, () => setMail({ configured: false, from: null }));
  }, [path]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function copy(share: ShareWithUrl) {
    void navigator.clipboard?.writeText(absolute(share.url)).then(
      () => setCopied(share.token),
      () => {},
    );
  }

  async function createLink() {
    setLinkError(null);
    try {
      const share = await api.createShare(path, EXPIRY_OPTIONS[expiry]!.days);
      setShares((s) => [...s, share]);
      copy(share);
    } catch (err) {
      setLinkError(errorText(err, 'Could not create link'));
    }
  }

  async function revoke(token: string) {
    setLinkError(null);
    try {
      await api.revokeShare(token);
      setShares((s) => s.filter((x) => x.token !== token));
    } catch (err) {
      setLinkError(errorText(err, 'Could not revoke link'));
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    // whatever is still typed counts too
    const recipients = [...pills];
    for (const r of parseRecipients(draft)) {
      if (!recipients.some((p) => p.toLowerCase() === r.toLowerCase())) recipients.push(r);
    }
    setPills(recipients);
    setDraft('');
    const invalid = recipients.filter((r) => !isValidEmail(r));
    if (invalid.length) {
      setMailResult({ ok: false, text: `${invalid.join(', ')} ${invalid.length === 1 ? 'is not a valid address' : 'are not valid addresses'}.` });
      return;
    }
    if (!recipients.length) {
      setMailResult({ ok: false, text: 'Add at least one recipient.' });
      return;
    }
    setSending(true);
    setMailResult(null);
    try {
      await api.email({ path, to: recipients, subject, message });
      rememberRecipients(recipients);
      setMailResult({ ok: true, text: `Sent to ${recipients.join(', ')}.` });
      setPills([]);
    } catch (err) {
      setMailResult({ ok: false, text: errorText(err, 'Sending failed') });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="overlay-panel share-dialog" role="dialog" aria-label="Share">
        <div className="share-header">
          <h2>Share “{title}”</h2>
          <button aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <section>
          <h3>Read-only link</h3>
          <p className="share-hint">Anyone with the link can read the current version of this note — no login needed.</p>
          {shares.map((s) => (
            <div className="share-link" key={s.token} data-testid="share-link">
              <input readOnly value={absolute(s.url)} onFocus={(e) => e.currentTarget.select()} />
              <button onClick={() => copy(s)}>{copied === s.token ? 'Copied' : 'Copy'}</button>
              <button className="danger" onClick={() => void revoke(s.token)}>Revoke</button>
              <span className="share-hint">
                {s.expiresAt ? `Expires ${new Date(s.expiresAt).toLocaleDateString()}` : 'Never expires'}
              </span>
            </div>
          ))}
          <div className="share-row">
            <select aria-label="Link expiry" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRY_OPTIONS.map((o, i) => (
                <option key={o.label} value={i}>{o.label}</option>
              ))}
            </select>
            <button className="primary" onClick={() => void createLink()}>Create link</button>
          </div>
          {linkError && <div className="share-error" role="alert">{linkError}</div>}
        </section>

        <section>
          <h3>Email as PDF</h3>
          {mail && !mail.configured ? (
            <p className="share-hint">
              Email isn’t set up on the server — set <code>SMTP_HOST</code>, <code>SMTP_USER</code>,{' '}
              <code>SMTP_PASS</code> and <code>MAIL_FROM</code> on the container.
            </p>
          ) : (
            <form className="share-form" onSubmit={(e) => void send(e)}>
              <RecipientInput
                label="To"
                pills={pills}
                draft={draft}
                suggestions={suggestions}
                onChange={(p, d) => {
                  setPills(p);
                  setDraft(d);
                }}
              />
              <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} required />
              <textarea
                aria-label="Message"
                placeholder="Message (optional)"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <div className="share-row">
                <button className="primary" type="submit" disabled={sending || !mail}>
                  {sending ? 'Sending…' : 'Send PDF'}
                </button>
                {mail?.from && <span className="share-hint">from {mail.from}</span>}
              </div>
              {mailResult && (
                <div className={mailResult.ok ? 'share-ok' : 'share-error'} role="status">{mailResult.text}</div>
              )}
            </form>
          )}
        </section>

        <div className="share-footer">
          <a href={api.pdfUrl(path)} download>Download PDF</a>
        </div>
      </div>
    </div>
  );
}
