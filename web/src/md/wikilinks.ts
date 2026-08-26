import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

const WIKI = /(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

export function remarkWikilinks() {
  return (tree: Root) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      WIKI.lastIndex = 0;
      if (!WIKI.test(value)) return;
      WIKI.lastIndex = 0;
      const parts: unknown[] = [];
      let last = 0;
      for (const m of value.matchAll(WIKI)) {
        const [full, bang, target, , alias] = m;
        const start = m.index;
        if (start > last) parts.push({ type: 'text', value: value.slice(last, start) });
        const cleanTarget = target!.trim();
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        if (bang === '!') {
          parts.push({
            type: 'html',
            value: `<img class="internal-embed" data-target="${esc(cleanTarget)}" alt="${esc(cleanTarget)}">`,
          });
        } else {
          const label = (alias ?? cleanTarget).trim();
          parts.push({
            type: 'html',
            value: `<a class="internal-link" data-target="${esc(cleanTarget)}">${esc(label)}</a>`,
          });
        }
        last = start + full.length;
      }
      if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
      parent.children.splice(index, 1, ...(parts as never[]));
      return index + parts.length;
    });
  };
}
