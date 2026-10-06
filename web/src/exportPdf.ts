import type { TreeNode } from '@noteviewer/shared';
import { enhanceRendered } from './md/enhance';
import { renderMarkdown } from './md/render';

const IMAGE_TIMEOUT_MS = 5000;

export const PAGE_SIZES = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export type PdfMargin = 'default' | 'minimal' | 'none';

/** The options of Obsidian's "Export to PDF" dialog. */
export interface PdfOptions {
  includeFileName: boolean;
  pageSize: PageSize;
  landscape: boolean;
  margin: PdfMargin;
  /** Downscale percent, 10–100. */
  scale: number;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = {
  includeFileName: true,
  pageSize: 'A4',
  landscape: false,
  margin: 'default',
  scale: 100,
};

const MARGINS: Record<PdfMargin, string> = {
  default: '18mm 16mm',
  minimal: '6mm',
  none: '0',
};

/** The `@page` rule (and content scale) for the given options. */
export function pageCss(opts: PdfOptions): string {
  const scale = Math.min(100, Math.max(10, Math.round(opts.scale))) / 100;
  return `@page { size: ${opts.pageSize}${opts.landscape ? ' landscape' : ''}; margin: ${MARGINS[opts.margin]}; }\n`
    + `@media print { #print-root { zoom: ${scale}; } }`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function imagesLoaded(el: HTMLElement): Promise<unknown> {
  const pending = [...el.querySelectorAll('img')]
    .filter((img) => !img.complete)
    .map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }));
  const timeout = new Promise((resolve) => setTimeout(resolve, IMAGE_TIMEOUT_MS));
  return Promise.race([Promise.all(pending), timeout]);
}

/**
 * Render a note into a print-only document (light theme, see `@media print`
 * in theme.css) and open the browser's print dialog, where "Save as PDF"
 * produces the file. The document title becomes the suggested file name.
 */
export async function exportPdf(
  title: string,
  content: string,
  tree: TreeNode | null,
  opts: PdfOptions = DEFAULT_PDF_OPTIONS,
): Promise<void> {
  document.getElementById('print-root')?.remove();
  document.getElementById('print-page-style')?.remove();
  const root = document.createElement('div');
  root.id = 'print-root';
  root.className = 'print-doc';
  let html = await renderMarkdown(content);
  // Mirror Obsidian: show the note name as a heading unless the note opens with its own H1.
  if (opts.includeFileName && !/^\s*<h1[\s>]/.test(html)) html = `<h1>${escapeHtml(title)}</h1>\n${html}`;
  root.innerHTML = html;
  const style = document.createElement('style');
  style.id = 'print-page-style';
  style.textContent = pageCss(opts);
  document.head.appendChild(style);
  document.body.appendChild(root);
  await enhanceRendered(root, tree, 'default');
  await imagesLoaded(root);

  const prevTitle = document.title;
  document.title = title;
  const cleanup = () => {
    document.title = prevTitle;
    root.remove();
    style.remove();
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();
}
