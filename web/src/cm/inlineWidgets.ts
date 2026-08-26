import katex from 'katex';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { encodePath } from '../api';

const INLINE_MATH = /(?<!\$)\$([^$\n]+)\$(?!\$)/g;
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
const EMBED = /!\[\[([^\]\n]+)\]\]/g;

// Fenced/indented code blocks and inline `code` spans should not have `$..$`
// spans inside them rendered as math (e.g. a shell variable in a snippet).
// Mirrors wikilinkPlugin's insideCode() gate.
const CODE_NODE_NAMES = new Set(['FencedCode', 'CodeBlock', 'CodeText', 'InlineCode']);

function insideCode(view: EditorView, pos: number): boolean {
  const start = syntaxTree(view.state).resolveInner(pos, 1);
  for (let n: typeof start | null = start; n; n = n.parent) {
    if (CODE_NODE_NAMES.has(n.name)) return true;
  }
  return false;
}

class CheckboxWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private pos: number,
  ) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-checkbox';
    box.checked = this.checked;
    box.onclick = (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? '[ ]' : '[x]' },
      });
    };
    return box;
  }
  override ignoreEvent() {
    return true;
  }
}

class MathWidget extends WidgetType {
  constructor(private src: string) {
    super();
  }
  override eq(other: MathWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const span = document.createElement('span');
    span.innerHTML = katex.renderToString(this.src, { throwOnError: false });
    return span;
  }
}

class ImageWidget extends WidgetType {
  constructor(private src: string) {
    super();
  }
  override eq(other: ImageWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-image';
    img.src = this.src;
    return img;
  }
}

function lineTouched(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  return view.state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
}

export function inlineWidgets(opts: { resolveFile(target: string): string | undefined }): Extension {
  function build(view: EditorView): DecorationSet {
    const entries: { f: number; t: number; d: Decoration }[] = [];
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: (node) => {
          if (node.name === 'TaskMarker') {
            const checked = /x/i.test(view.state.doc.sliceString(node.from, node.to));
            entries.push({
              f: node.from,
              t: node.to,
              d: Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }),
            });
          }
        },
      });
      const text = view.state.doc.sliceString(from, to);
      for (const m of text.matchAll(INLINE_MATH)) {
        const start = from + m.index!;
        if (lineTouched(view, start)) continue;
        if (insideCode(view, start)) continue;
        entries.push({
          f: start,
          t: start + m[0].length,
          d: Decoration.replace({ widget: new MathWidget(m[1]!) }),
        });
      }
      const addImage = (start: number, matchLen: number, rawTarget: string) => {
        if (lineTouched(view, start)) return;
        const isUrl = /^https?:\/\//.test(rawTarget);
        const resolved = isUrl ? rawTarget : opts.resolveFile(rawTarget);
        if (!resolved) return;
        const src = isUrl ? resolved : `/api/file/${encodePath(resolved)}`;
        const line = view.state.doc.lineAt(start);
        entries.push({
          f: line.to,
          t: line.to,
          d: Decoration.widget({ widget: new ImageWidget(src), side: 1, block: false }),
        });
      };
      for (const m of text.matchAll(MD_IMAGE)) addImage(from + m.index!, m[0].length, m[2]!.trim());
      for (const m of text.matchAll(EMBED)) addImage(from + m.index!, m[0].length, m[1]!.trim());
    }
    entries.sort((a, b) => a.f - b.f || a.t - b.t);
    const builder = new RangeSetBuilder<Decoration>();
    for (const { f, t, d } of entries) builder.add(f, t, d);
    return builder.finish();
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
