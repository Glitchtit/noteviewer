import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPdf } from '../src/exportPdf';

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
});
