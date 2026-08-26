import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { inlineWidgets } from '../src/cm/inlineWidgets';

function viewWith(doc: string, cursor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      markdown({ base: markdownLanguage }),
      inlineWidgets({ resolveFile: (t) => (t === 'pic.png' ? 'sub/pic.png' : undefined) }),
    ],
  });
  const view = new EditorView({ state, parent: document.body });
  ensureSyntaxTree(view.state, doc.length, 5000);
  // force a decoration recompute now that the tree is available
  view.dispatch({ selection: EditorSelection.cursor(cursor) });
  return view;
}

describe('inline widgets', () => {
  it('renders checkbox inputs for task markers and toggles on click', () => {
    const view = viewWith('- [ ] buy milk\n\nelsewhere', 20);
    const box = view.dom.querySelector<HTMLInputElement>('input.cm-checkbox');
    expect(box).toBeTruthy();
    box!.click();
    expect(view.state.doc.toString()).toContain('- [x] buy milk');
    view.destroy();
  });

  it('renders inline math via katex when cursor elsewhere', () => {
    const view = viewWith('energy $e=mc^2$ here\n\nx', 23);
    expect(view.dom.querySelector('.katex')).toBeTruthy();
    view.destroy();
  });

  it('shows raw math source on the active line', () => {
    const view = viewWith('energy $e=mc^2$ here', 3);
    expect(view.dom.querySelector('.katex')).toBeFalsy();
    view.destroy();
  });

  it('adds image widgets below lines with embeds', () => {
    const view = viewWith('![[pic.png]]\n\nelsewhere', 16);
    const img = view.dom.querySelector<HTMLImageElement>('img.cm-image');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('/api/file/sub/pic.png');
    view.destroy();
  });

  it('does not render math inside an inline code span', () => {
    const view = viewWith('use `$x$` literally\n\nelsewhere', 25);
    expect(view.dom.querySelector('.katex')).toBeFalsy();
    view.destroy();
  });
});
