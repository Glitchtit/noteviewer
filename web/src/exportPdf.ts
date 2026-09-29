import type { TreeNode } from '@noteviewer/shared';
import { enhanceRendered } from './md/enhance';
import { renderMarkdown } from './md/render';

const IMAGE_TIMEOUT_MS = 5000;

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
export async function exportPdf(title: string, content: string, tree: TreeNode | null): Promise<void> {
  document.getElementById('print-root')?.remove();
  const root = document.createElement('div');
  root.id = 'print-root';
  root.className = 'print-doc';
  let html = await renderMarkdown(content);
  // Mirror Obsidian: show the note name as a heading unless the note opens with its own H1.
  if (!/^\s*<h1[\s>]/.test(html)) html = `<h1>${escapeHtml(title)}</h1>\n${html}`;
  root.innerHTML = html;
  document.body.appendChild(root);
  await enhanceRendered(root, tree, 'default');
  await imagesLoaded(root);

  const prevTitle = document.title;
  document.title = title;
  const cleanup = () => {
    document.title = prevTitle;
    root.remove();
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();
}
