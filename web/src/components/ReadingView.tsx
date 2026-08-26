import { useEffect, useRef, useState } from 'react';
import type { TreeNode } from '@noteviewer/shared';
import { encodePath } from '../api';
import { renderMarkdown } from '../md/render';
import { resolveLink } from '../resolveLink';

export interface ReadingViewProps {
  content: string;
  tree: TreeNode | null;
  onOpenNote(path: string): void;
}

let mermaidSeq = 0;

export function ReadingView({ content, tree, onOpenNote }: ReadingViewProps) {
  const [html, setHtml] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const openRef = useRef(onOpenNote);
  openRef.current = onOpenNote;

  useEffect(() => {
    let cancelled = false;
    void renderMarkdown(content).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [content]);

  // post-render enhancement: embeds and mermaid
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !html) return;
    for (const img of el.querySelectorAll<HTMLImageElement>('img.internal-embed')) {
      const target = img.dataset['target'];
      const resolved = target && treeRef.current ? resolveLink(treeRef.current, target) : undefined;
      if (resolved) img.src = `/api/file/${encodePath(resolved)}`;
    }
    const fences = el.querySelectorAll<HTMLElement>('code.language-mermaid');
    if (fences.length) {
      void import('mermaid').then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, theme: 'dark' });
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
      });
    }
  }, [html]);

  function onClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest('a.internal-link');
    if (!a) return;
    e.preventDefault();
    const target = (a as HTMLElement).dataset['target'];
    const resolved = target && treeRef.current ? resolveLink(treeRef.current, target) : undefined;
    if (resolved) openRef.current(resolved);
  }

  return (
    <div
      ref={containerRef}
      className="reading-view"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
