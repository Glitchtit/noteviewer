import { describe, expect, it } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { buildHideDecorations, livePreview } from '../src/cm/livePreview';

function viewWith(doc: string, cursor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), livePreview],
  });
  const view = new EditorView({ state, parent: document.body });
  ensureSyntaxTree(view.state, doc.length, 5000);
  return view;
}

function hiddenCount(view: EditorView): number {
  let n = 0;
  buildHideDecorations(view).between(0, view.state.doc.length, () => {
    n++;
  });
  return n;
}

describe('livePreview mark hiding', () => {
  it('hides heading and emphasis marks when the cursor is elsewhere', () => {
    const view = viewWith('# Title\n\nsome **bold** text\n\nplain', 34);
    expect(hiddenCount(view)).toBeGreaterThanOrEqual(3); // header mark + two strong marks
    view.destroy();
  });

  it('reveals marks on the active line', () => {
    const doc = '# Title\n\nsome **bold** text';
    const away = viewWith(doc, doc.length);
    const onHeading = viewWith(doc, 2);
    expect(hiddenCount(onHeading)).toBeLessThan(hiddenCount(away));
    away.destroy();
    onHeading.destroy();
  });

  it('reveals quote marks per-line, not for the whole blockquote', () => {
    const doc = '> line one\n> line two\n\nelsewhere';
    const away = viewWith(doc, doc.length);
    // position 4 is inside "line one" on the first quoted line
    const onFirstLine = viewWith(doc, 4);

    let awayHiddenQuoteMarks = 0;
    buildHideDecorations(away).between(0, away.state.doc.length, (from, to) => {
      if (doc.slice(from, from + 1) === '>' || doc.slice(from, to) === '> ') awayHiddenQuoteMarks++;
    });
    expect(awayHiddenQuoteMarks).toBe(2);

    const firstLine = away.state.doc.line(1);
    const secondLine = away.state.doc.line(2);
    let firstLineHidden = 0;
    let secondLineHidden = 0;
    buildHideDecorations(onFirstLine).between(0, onFirstLine.state.doc.length, (from) => {
      if (from >= firstLine.from && from <= firstLine.to) firstLineHidden++;
      if (from >= secondLine.from && from <= secondLine.to) secondLineHidden++;
    });
    expect(firstLineHidden).toBe(0);
    expect(secondLineHidden).toBe(1);

    away.destroy();
    onFirstLine.destroy();
  });
});
