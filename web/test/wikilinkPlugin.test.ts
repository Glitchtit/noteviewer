import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { buildWikilinkDecorations, wikilinkExtensions } from '../src/cm/wikilinkPlugin';

function viewWith(doc: string, cursor: number, onOpen = vi.fn()): { view: EditorView; onOpen: ReturnType<typeof vi.fn> } {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), wikilinkExtensions({ onOpen, noteNames: () => ['Other', 'Deep/Note'] })],
  });
  return { view: new EditorView({ state, parent: document.body }), onOpen };
}

describe('wikilink plugin', () => {
  it('marks wikilinks and hides brackets when cursor elsewhere', () => {
    const { view } = viewWith('go to [[Other]] now\nsecond line', 25);
    const decos = buildWikilinkDecorations(view, () => ['Other']);
    let marks = 0;
    let hidden = 0;
    decos.between(0, view.state.doc.length, (_f, _t, d) => {
      const spec = d.spec as { class?: string };
      if (spec.class?.includes('cm-wikilink')) marks++;
      else hidden++;
    });
    expect(marks).toBeGreaterThanOrEqual(1);
    expect(hidden).toBeGreaterThanOrEqual(2); // [[ and ]]
    view.destroy();
  });

  it('reveals brackets on the active line', () => {
    const { view } = viewWith('go to [[Other]] now', 8);
    const decos = buildWikilinkDecorations(view, () => ['Other']);
    let hidden = 0;
    decos.between(0, view.state.doc.length, (_f, _t, d) => {
      if (!(d.spec as { class?: string }).class) hidden++;
    });
    expect(hidden).toBe(0);
    view.destroy();
  });

  it('marks tags', () => {
    const { view } = viewWith('text #mytag more\nline2', 20);
    const decos = buildWikilinkDecorations(view, () => []);
    let tag = 0;
    decos.between(0, view.state.doc.length, (_f, _t, d) => {
      if ((d.spec as { class?: string }).class?.includes('cm-tag')) tag++;
    });
    expect(tag).toBe(1);
    view.destroy();
  });

  it('skips tags inside fenced code and inline code', () => {
    const doc = [
      '```python',
      '# #notatag',
      '```',
      '',
      'inline `#alsonot` code',
      '',
      'a #realtag outside code',
    ].join('\n');
    const { view } = viewWith(doc, 0);
    ensureSyntaxTree(view.state, doc.length, 5000);
    const decos = buildWikilinkDecorations(view, () => []);
    let tag = 0;
    decos.between(0, view.state.doc.length, (_f, _t, d) => {
      if ((d.spec as { class?: string }).class?.includes('cm-tag')) tag++;
    });
    expect(tag).toBe(1);
    view.destroy();
  });
});
