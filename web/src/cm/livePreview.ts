import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

const HIDDEN_MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'QuoteMark',
]);

const hideMark = Decoration.replace({});

// A mark reveals when the selection touches the enclosing markdown construct
// (e.g. the ATXHeading for a HeaderMark, the StrongEmphasis/Emphasis node for
// an EmphasisMark) rather than merely the raw physical text line. For
// single-line constructs like ATX headings the two coincide, but for inline
// spans inside a longer paragraph (e.g. **bold** followed by more prose) this
// keeps the marks hidden once the cursor has moved past that specific span,
// even though it is still on the same physical line.
function selectionTouchesExtent(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

export function buildHideDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (!HIDDEN_MARKS.has(node.name)) return;
        const parent = node.node.parent;
        const extentFrom = parent ? parent.from : node.from;
        const extentTo = parent ? parent.to : node.to;
        if (selectionTouchesExtent(view, extentFrom, extentTo)) return;
        let end = node.to;
        // HeaderMark: also swallow the single space after `#`
        if (node.name === 'HeaderMark' && view.state.doc.sliceString(end, end + 1) === ' ') end += 1;
        builder.add(node.from, end, hideMark);
      },
    });
  }
  return builder.finish();
}

export const livePreview: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHideDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildHideDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
