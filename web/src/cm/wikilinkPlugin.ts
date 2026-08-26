import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

const WIKI = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
const TAG = /(^|\s)#([A-Za-z0-9_][\w/-]*)/g;

// Fenced/indented code blocks and inline `code` spans should not have `#foo`
// tokens inside them treated as tags (e.g. a shell/Python comment in a fenced
// snippet). Walk up from the match position and bail if any ancestor is a
// code node.
const CODE_NODE_NAMES = new Set(['FencedCode', 'CodeBlock', 'CodeText', 'InlineCode']);

function insideCode(view: EditorView, pos: number): boolean {
  const start = syntaxTree(view.state).resolveInner(pos, 1);
  for (let n: typeof start | null = start; n; n = n.parent) {
    if (CODE_NODE_NAMES.has(n.name)) return true;
  }
  return false;
}

export interface WikilinkOpts {
  onOpen(target: string): void;
  noteNames(): string[];
}

function lineTouched(view: EditorView, from: number, to: number): boolean {
  const line = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(Math.min(to, view.state.doc.length));
  return view.state.selection.ranges.some((r) => r.from <= endLine.to && r.to >= line.from);
}

export function buildWikilinkDecorations(view: EditorView, _names: () => string[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const found: { f: number; t: number; d: Decoration }[] = [];
    for (const m of text.matchAll(WIKI)) {
      const start = from + m.index!;
      const end = start + m[0].length;
      const target = m[1]!.trim();
      const active = lineTouched(view, start, end);
      const labelStart = m[3] !== undefined ? start + m[0].indexOf('|') + 1 : start + 2;
      const labelEnd = end - 2;
      if (!active) {
        found.push({ f: start, t: labelStart, d: Decoration.replace({}) });
        found.push({
          f: labelStart,
          t: labelEnd,
          d: Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-target': target } }),
        });
        found.push({ f: labelEnd, t: end, d: Decoration.replace({}) });
      } else {
        found.push({
          f: start,
          t: end,
          d: Decoration.mark({ class: 'cm-wikilink cm-wikilink-active', attributes: { 'data-target': target } }),
        });
      }
    }
    for (const m of text.matchAll(TAG)) {
      const start = from + m.index! + m[1]!.length;
      if (insideCode(view, start)) continue;
      found.push({
        f: start,
        t: start + 1 + m[2]!.length,
        d: Decoration.mark({ class: 'cm-tag' }),
      });
    }
    found.sort((a, b) => a.f - b.f || a.t - b.t);
    for (const { f, t, d } of found) builder.add(f, t, d);
  }
  return builder.finish();
}

export function wikilinkExtensions(opts: WikilinkOpts): Extension[] {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildWikilinkDecorations(view, opts.noteNames);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = buildWikilinkDecorations(u.view, opts.noteNames);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const click = EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest('.cm-wikilink');
      if (el && e.button === 0 && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const target = (el as HTMLElement).dataset['target'];
        if (target) {
          e.preventDefault();
          opts.onOpen(target);
          return true;
        }
      }
      return false;
    },
  });

  function completions(ctx: CompletionContext): CompletionResult | null {
    const word = ctx.matchBefore(/\[\[[^\]]*/);
    if (!word) return null;
    return {
      from: word.from + 2,
      options: opts.noteNames().map((n) => ({ label: n, apply: `${n}]]` })),
      validFor: /^[^\]]*$/,
    };
  }

  return [plugin, click, autocompletion({ override: [completions] })];
}
