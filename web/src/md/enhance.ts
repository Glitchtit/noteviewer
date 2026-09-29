import type { TreeNode } from '@noteviewer/shared';
import { encodePath } from '../api';
import { resolveLink } from '../resolveLink';

let mermaidSeq = 0;

/**
 * Post-render enhancement of renderMarkdown() output already in the DOM:
 * points ![[embeds]] at /api/file and swaps ```mermaid fences for diagrams.
 * Resolves once every diagram has been attempted.
 */
export async function enhanceRendered(
  el: HTMLElement,
  tree: TreeNode | null,
  mermaidTheme: 'dark' | 'default' = 'dark',
): Promise<void> {
  for (const img of el.querySelectorAll<HTMLImageElement>('img.internal-embed')) {
    const target = img.dataset['target'];
    const resolved = target && tree ? resolveLink(tree, target) : undefined;
    if (resolved) img.src = `/api/file/${encodePath(resolved)}`;
  }
  const fences = el.querySelectorAll<HTMLElement>('code.language-mermaid');
  if (!fences.length) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, theme: mermaidTheme });
  for (const code of fences) {
    const src = code.textContent ?? '';
    const host = code.closest('pre') ?? code;
    try {
      const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, src);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-diagram';
      wrap.innerHTML = svg;
      host.replaceWith(wrap);
    } catch {
      // leave the raw code block visible on render failure
    }
  }
}
