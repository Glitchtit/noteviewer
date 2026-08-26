import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { blockWidgets } from '../src/cm/blockWidgets';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg class="mermaid-test"></svg>' }),
  },
}));

function viewWith(doc: string, cursor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), blockWidgets],
  });
  const view = new EditorView({ state, parent: document.body });
  ensureSyntaxTree(view.state, doc.length, 5000);
  view.dispatch({ selection: EditorSelection.cursor(cursor) });
  return view;
}

describe('block widgets', () => {
  it('renders block math as display katex when cursor outside', () => {
    const doc = 'before\n\n$$\\sum i$$\n\nafter';
    const view = viewWith(doc, 0);
    expect(view.dom.querySelector('.katex-display')).toBeTruthy();
    view.destroy();
  });

  it('shows raw block math when cursor inside', () => {
    const doc = 'before\n\n$$\\sum i$$\n\nafter';
    const view = viewWith(doc, 10);
    expect(view.dom.querySelector('.katex-display')).toBeFalsy();
    view.destroy();
  });

  it('replaces mermaid fences with an async-rendered container', async () => {
    const doc = 'x\n\n```mermaid\ngraph TD; A-->B;\n```\n\ny';
    const view = viewWith(doc, 0);
    expect(view.dom.querySelector('.cm-mermaid')).toBeTruthy();
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid-test')).toBeTruthy());
    view.destroy();
  });

  it('adds callout line classes', () => {
    const doc = '> [!note] hi\n> body\n\nx';
    const view = viewWith(doc, doc.length);
    expect(view.dom.querySelector('.cm-callout')).toBeTruthy();
    view.destroy();
  });

  it('does not render block math inside a fenced code block', () => {
    const doc = 'before\n\n```\n$$\\sum i$$\n```\n\nafter';
    const view = viewWith(doc, 0);
    expect(view.dom.querySelector('.katex-display')).toBeFalsy();
    view.destroy();
  });

  it('renders mid-line $$...$$ as inline (non-block) display math without corrupting line structure', () => {
    const doc = 'before $$x^2$$ after\n\nelse';
    const view = viewWith(doc, doc.length);
    expect(view.dom.querySelector('.katex-display')).toBeTruthy();
    // The source line must stay a single `.cm-line`, not be split around an
    // orphaned block-widget sibling.
    expect(view.dom.querySelectorAll('.cm-line').length).toBe(3);
    view.destroy();
  });

  it('does not decorate a $$ that opens mid-line and closes on another line', () => {
    const doc = 'z\n\ntext $$foo\nbar$$ end\n\nq';
    const view = viewWith(doc, doc.length);
    expect(view.dom.querySelector('.katex-display')).toBeFalsy();
    // Both source lines must stay intact as their own `.cm-line`s.
    expect(view.dom.querySelectorAll('.cm-line').length).toBe(6);
    view.destroy();
  });

  it('classes all lines of a multi-line callout without losing the head', () => {
    const doc = '> [!warning] head\n> line2\n> line3\n\nx';
    const view = viewWith(doc, doc.length);
    const callouts = view.dom.querySelectorAll('.cm-callout-warning');
    expect(callouts.length).toBe(3);
    view.destroy();
  });
});
