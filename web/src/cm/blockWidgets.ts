import katex from 'katex';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

const BLOCK_MATH = /\$\$([\s\S]+?)\$\$/g;
const CALLOUT_HEAD = /^>\s*\[!(\w+)\]/;

// Fenced/indented code blocks should not have `$$..$$` spans inside them
// rendered as math (e.g. a literal `$$` in a shell snippet).
// Mirrors inlineWidgets' insideCode() gate.
const CODE_NODE_NAMES = new Set(['FencedCode', 'CodeBlock', 'CodeText', 'InlineCode']);

function insideCode(state: EditorState, pos: number): boolean {
  const start = syntaxTree(state).resolveInner(pos, 1);
  for (let n: typeof start | null = start; n; n = n.parent) {
    if (CODE_NODE_NAMES.has(n.name)) return true;
  }
  return false;
}

let mermaidSeq = 0;

class BlockMathWidget extends WidgetType {
  constructor(private src: string) {
    super();
  }
  override eq(other: BlockMathWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const div = document.createElement('div');
    div.innerHTML = katex.renderToString(this.src, { throwOnError: false, displayMode: true });
    return div;
  }
}

class MermaidWidget extends WidgetType {
  constructor(private src: string) {
    super();
  }
  override eq(other: MermaidWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-mermaid';
    const src = this.src;
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      try {
        const { svg } = await mermaid.render(`cmmd-${mermaidSeq++}`, src);
        div.innerHTML = svg;
      } catch {
        div.textContent = 'mermaid render error';
      }
    });
    return div;
  }
}

function regionTouched(state: EditorState, from: number, to: number): boolean {
  const fromLine = state.doc.lineAt(from);
  const toLine = state.doc.lineAt(Math.min(to, state.doc.length));
  return state.selection.ranges.some((r) => r.from <= toLine.to && r.to >= fromLine.from);
}

function build(state: EditorState): DecorationSet {
  const entries: { f: number; t: number; d: Decoration }[] = [];
  const doc = state.doc;
  const text = doc.toString();

  for (const m of text.matchAll(BLOCK_MATH)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (regionTouched(state, start, end)) continue;
    if (insideCode(state, start)) continue;

    // Block-level `Decoration.replace` requires the range to be aligned to
    // whole lines (from a line's start to a line's end). A `$$...$$` span
    // that shares a line with other text doesn't satisfy that, and CM6's
    // line/DOM structure gets corrupted if we force `block: true` on it
    // anyway (the containing line is split and the widget spliced in as an
    // orphaned sibling, outside any `.cm-line`). So: use a block widget only
    // when aligned; when the span shares just its own single line with other
    // text, fall back to a non-block (inline) replace, which still renders
    // KaTeX in `displayMode`; when it's unaligned *and* crosses a line break
    // (e.g. `$$` opening mid-line and closing on a later line), skip
    // decorating it entirely rather than risk the same corruption.
    const fromLine = doc.lineAt(start);
    const toLine = doc.lineAt(Math.min(end, doc.length));
    const aligned = start === fromLine.from && end === toLine.to;
    const sameLine = fromLine.number === toLine.number;
    if (!aligned && !sameLine) continue;

    const widget = new BlockMathWidget(m[1]!.trim());
    const deco = aligned ? Decoration.replace({ widget, block: true }) : Decoration.replace({ widget });
    entries.push({ f: start, t: end, d: deco });
  }

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const info = state.doc.sliceString(node.from, Math.min(node.from + 20, node.to));
      if (!/^```\s*mermaid/.test(info)) return;
      if (regionTouched(state, node.from, node.to)) return;
      const src = state.doc
        .sliceString(node.from, node.to)
        .replace(/^```\s*mermaid\s*\n?/, '')
        .replace(/\n?```\s*$/, '');
      entries.push({ f: node.from, t: node.to, d: Decoration.replace({ widget: new MermaidWidget(src), block: true }) });
    },
  });

  // Single forward pass: track the current quote-run's callout class (or
  // null) as we go, resolving it once at the head of each run rather than
  // re-walking backward from every line (which made a K-line blockquote cost
  // O(K^2), repaid on every keystroke/cursor move).
  let runClass: string | null = null;
  let prevWasQuote = false;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const isQuote = line.text.startsWith('>');
    if (!isQuote) {
      runClass = null;
      prevWasQuote = false;
      continue;
    }
    if (!prevWasQuote) {
      const m = CALLOUT_HEAD.exec(line.text);
      runClass = m ? `cm-callout cm-callout-${m[1]!.toLowerCase()}` : null;
    }
    prevWasQuote = true;
    if (runClass) {
      entries.push({ f: line.from, t: line.from, d: Decoration.line({ class: runClass }) });
    }
  }

  entries.sort((a, b) => a.f - b.f || a.t - b.t);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { f, t, d } of entries) builder.add(f, t, d);
  return builder.finish();
}

// A block-level `Decoration.replace` (used for the math/mermaid widgets)
// can only be produced by a static decoration source; CM6 rejects it when
// the source is a dynamic per-view function, which is what
// `ViewPlugin.fromClass({ decorations })` registers as. A `StateField`
// providing `EditorView.decorations.from(field)` yields a plain
// per-state `DecorationSet` value instead, which CM6 accepts for block
// decorations. (Latitude clause: the brief's ViewPlugin reference throws
// "Block decorations may not be specified via plugins" at runtime.)
export const blockWidgets: Extension = StateField.define<DecorationSet>({
  create(state) {
    return build(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.selection) return build(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
