import { useEffect, useState } from 'react';
import { DEFAULT_PDF_OPTIONS, PAGE_SIZES, type PageSize, type PdfMargin, type PdfOptions } from '../exportPdf';

const STORAGE_KEY = 'noteviewer.pdfOptions';

/** The last-used options, like Obsidian remembers them between exports. */
export function loadPdfOptions(): PdfOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_PDF_OPTIONS, ...JSON.parse(raw) };
  } catch {
    // Storage unavailable or corrupt: fall back to defaults.
  }
  return DEFAULT_PDF_OPTIONS;
}

function savePdfOptions(opts: PdfOptions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(opts));
  } catch {
    // Not remembering the options is harmless.
  }
}

export interface ExportPdfDialogProps {
  title: string;
  onExport(opts: PdfOptions): void;
  onClose(): void;
}

/** Obsidian's "Export to PDF" dialog: page setup, then the browser's print dialog saves the file. */
export function ExportPdfDialog({ title, onExport, onClose }: ExportPdfDialogProps) {
  const [opts, setOpts] = useState<PdfOptions>(loadPdfOptions);
  const set = <K extends keyof PdfOptions>(key: K, value: PdfOptions[K]) =>
    setOpts((o) => ({ ...o, [key]: value }));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submit() {
    savePdfOptions(opts);
    onExport(opts);
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <form
        className="overlay-panel pdf-dialog"
        role="dialog"
        aria-label="Export to PDF"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <h2>Export to PDF</h2>
        <p className="pdf-dialog-note">{title}</p>
        <label className="pdf-row">
          <span>Include file name as title</span>
          <input
            type="checkbox"
            checked={opts.includeFileName}
            onChange={(e) => set('includeFileName', e.target.checked)}
          />
        </label>
        <label className="pdf-row">
          <span>Page size</span>
          <select value={opts.pageSize} onChange={(e) => set('pageSize', e.target.value as PageSize)}>
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="pdf-row">
          <span>Landscape</span>
          <input type="checkbox" checked={opts.landscape} onChange={(e) => set('landscape', e.target.checked)} />
        </label>
        <label className="pdf-row">
          <span>Margin</span>
          <select value={opts.margin} onChange={(e) => set('margin', e.target.value as PdfMargin)}>
            <option value="default">Default</option>
            <option value="minimal">Minimal</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="pdf-row">
          <span>Downscale percent</span>
          <span className="pdf-scale">
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={opts.scale}
              onChange={(e) => set('scale', Number(e.target.value))}
            />
            <output>{opts.scale}%</output>
          </span>
        </label>
        <p className="pdf-dialog-hint">Choose “Save as PDF” as the destination in the print dialog.</p>
        <div className="pdf-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" autoFocus>Export to PDF</button>
        </div>
      </form>
    </div>
  );
}
