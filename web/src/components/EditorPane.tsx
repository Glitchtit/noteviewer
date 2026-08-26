import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { cmTheme } from '../cm/theme';

export interface EditorPaneHandle {
  view: EditorView | null;
}

export interface EditorPaneProps {
  /** Read once at mount. Parents replace content by remounting with a new React `key`. */
  initialContent: string;
  onChange(text: string): void;
  onSave(): void;
}

export const EditorPane = forwardRef<EditorPaneHandle, EditorPaneProps>(function EditorPane(
  { initialContent, onChange, onSave },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useImperativeHandle(ref, () => ({
    get view() {
      return viewRef.current;
    },
  }), []);

  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          history(),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true; } },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          cmTheme,
        ],
      }),
      parent: containerRef.current!,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // mount-only: content replacement happens via key-based remount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="editor" />;
});
