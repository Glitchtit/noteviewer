import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PDF_OPTIONS, exportPdf, pageCss } from '../src/exportPdf';

afterEach(() => vi.restoreAllMocks());

describe('exportPdf', () => {
  it('renders the note into a print root, prints, and cleans up', async () => {
    let printed: HTMLElement | null = null;
    let titleAtPrint = '';
    vi.spyOn(window, 'print').mockImplementation(() => {
      printed = document.getElementById('print-root');
      titleAtPrint = document.title;
    });
    document.title = 'noteviewer';
    await exportPdf('My <Note>', 'Some **bold** text', null);
    expect(printed).not.toBeNull();
    expect(printed!.querySelector('h1')!.textContent).toBe('My <Note>');
    expect(printed!.querySelector('strong')!.textContent).toBe('bold');
    expect(titleAtPrint).toBe('My <Note>');
    window.dispatchEvent(new Event('afterprint'));
    expect(document.getElementById('print-root')).toBeNull();
    expect(document.title).toBe('noteviewer');
  });

  it("keeps the note's own H1 instead of adding the title", async () => {
    let printed: HTMLElement | null = null;
    vi.spyOn(window, 'print').mockImplementation(() => {
      printed = document.getElementById('print-root');
    });
    await exportPdf('file-name', '# Real Title\n\nbody', null);
    expect(printed!.querySelectorAll('h1')).toHaveLength(1);
    expect(printed!.querySelector('h1')!.textContent).toBe('Real Title');
    window.dispatchEvent(new Event('afterprint'));
  });

  it('applies page setup while printing and omits the title when asked', async () => {
    let printed: HTMLElement | null = null;
    let css = '';
    vi.spyOn(window, 'print').mockImplementation(() => {
      printed = document.getElementById('print-root');
      css = document.getElementById('print-page-style')?.textContent ?? '';
    });
    const opts = { includeFileName: false, pageSize: 'Letter', landscape: true, margin: 'none', scale: 80 } as const;
    await exportPdf('file-name', 'body', null, opts);
    expect(printed!.querySelector('h1')).toBeNull();
    expect(css).toContain('size: Letter landscape');
    expect(css).toContain('margin: 0');
    expect(css).toContain('zoom: 0.8');
    window.dispatchEvent(new Event('afterprint'));
    expect(document.getElementById('print-page-style')).toBeNull();
  });
});

describe('pageCss', () => {
  it('uses portrait A4 with default margins by default and clamps the scale', () => {
    expect(pageCss(DEFAULT_PDF_OPTIONS)).toContain('size: A4; margin: 18mm 16mm;');
    expect(pageCss({ ...DEFAULT_PDF_OPTIONS, scale: 1 })).toContain('zoom: 0.1');
  });
});
