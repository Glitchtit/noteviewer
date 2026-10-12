import { useEffect } from 'react';
import { api } from '../api';
import { buildPrintDocument } from '../exportPdf';

declare global {
  interface Window {
    /** set for the server's headless Chromium: 'ok' when ready to print, else an error */
    __nvReady?: string;
  }
}

/**
 * `/print?path=…` — loaded by the server's headless Chromium to produce the
 * PDFs that get emailed or downloaded; never linked from the UI. It builds
 * the same `#print-root` document as Export to PDF (default options).
 */
export function PrintView({ path }: { path: string }) {
  useEffect(() => {
    void (async () => {
      try {
        const [note, tree] = await Promise.all([api.note(path), api.tree()]);
        document.title = note.meta.title;
        await buildPrintDocument(note.meta.title, note.content, tree);
        // KaTeX/web fonts must be in before Chromium snapshots the page
        await document.fonts.ready;
        window.__nvReady = 'ok';
      } catch (err) {
        window.__nvReady = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  }, [path]);
  return null;
}
