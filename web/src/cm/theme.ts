import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const base = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--bg)', color: 'var(--text)', height: '100%', fontSize: '15px' },
    '.cm-content': {
      caretColor: 'var(--accent)',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      padding: '16px 24px',
      maxWidth: '760px',
      margin: '0 auto',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#3a3f58' },
    '.cm-line': { lineHeight: '1.6' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.6em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.35em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '700' },
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--accent)' },
  { tag: tags.monospace, fontFamily: 'monospace', color: '#a8c0e0' },
  { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: 'var(--text-muted)' },
]);

export const cmTheme: Extension[] = [base, syntaxHighlighting(highlight)];
