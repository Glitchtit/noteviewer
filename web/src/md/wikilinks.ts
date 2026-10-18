import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { parseImageSize, splitImageAlt } from './imageSize';

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
          const size = parseImageSize(alias);
          const alt = !size && alias?.trim() ? alias.trim() : cleanTarget;
          const dims =
            (size?.width ? ` width="${size.width}"` : '') + (size?.height ? ` height="${size.height}"` : '');
          parts.push({
            type: 'html',
            value: `<img class="internal-embed" data-target="${esc(cleanTarget)}" alt="${esc(alt)}"${dims}>`,
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
    // ![alt|300](url): Obsidian puts the size in the alt text
    visit(tree, 'image', (node) => {
      const { alt, size } = splitImageAlt(node.alt ?? '');
      if (!size) return;
      node.alt = alt;
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, width: size.width, height: size.height },
      };
    });
  };
}
