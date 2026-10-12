import { useEffect, useState } from 'react';
import type { PublicNote } from '@noteviewer/shared';
import { api } from '../api';
import { exportPdf } from '../exportPdf';
import { ReadingView } from './ReadingView';

/** `/s/:token` — what someone opening a public share link sees. */
export function SharedView({ token }: { token: string }) {
  const [note, setNote] = useState<PublicNote | null | 'missing'>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const n = await api.publicNote(token);
        if (cancelled) return;
        document.title = n.title;
        setNote(n);
      } catch {
        if (!cancelled) setNote('missing');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const embedUrl = (t: string) => `/api/public/${encodeURIComponent(token)}/embed/${encodeURIComponent(t)}`;

  if (note === 'missing') {
    return (
      <div className="shared">
        <div className="empty" data-testid="share-missing">
          This link has expired or is no longer shared.
        </div>
      </div>
    );
  }
  return (
    <div className="shared">
      <header className="topbar">
        <span className="title" data-testid="note-title">{note?.title ?? ''}</span>
        <span className="shared-badge">Read-only</span>
        {note && (
          <button onClick={() => void exportPdf(note.title, note.content, null, undefined, embedUrl)}>
            Print / PDF
          </button>
        )}
      </header>
      {note && (
        <ReadingView
          content={note.content}
          tree={null}
          embedUrl={embedUrl}
        />
      )}
    </div>
  );
}
