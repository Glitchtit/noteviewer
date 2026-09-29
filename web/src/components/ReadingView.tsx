import { useEffect, useRef, useState } from 'react';
import type { TreeNode } from '@noteviewer/shared';
import { enhanceRendered } from '../md/enhance';
import { renderMarkdown } from '../md/render';
import { resolveLink } from '../resolveLink';

export interface ReadingViewProps {
  content: string;
  tree: TreeNode | null;
  onOpenNote(path: string): void;
}

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
    void enhanceRendered(el, treeRef.current);
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
