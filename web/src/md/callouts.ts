import type { Blockquote, Paragraph, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

const CALLOUT = /^\[!(\w+)\][ \t]*(.*)$/;

export function remarkCallouts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const first = node.children[0];
      if (!first || first.type !== 'paragraph') return;
      const para = first;
      const t = para.children[0];
      if (!t || t.type !== 'text') return;
      const text: Text = t;
      const m = CALLOUT.exec(text.value.split('\n')[0]!);
      if (!m) return;
      const [, type, title] = m;
      const rest = text.value.slice(text.value.indexOf('\n') + 1);
      if (text.value.includes('\n')) text.value = rest;
      else para.children.shift();
      const data = (node.data ??= {});
      (data as { hName?: string }).hName = 'div';
      (data as { hProperties?: object }).hProperties = { className: ['callout', `callout-${type!.toLowerCase()}`] };
      node.children.unshift({
        type: 'paragraph',
        data: { hName: 'div', hProperties: { className: ['callout-title'] } },
        children: [{ type: 'text', value: title || type! }],
      } as Paragraph);
    });
  };
}
