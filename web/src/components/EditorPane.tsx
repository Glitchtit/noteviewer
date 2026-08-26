import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { blockWidgets } from '../cm/blockWidgets';
import { inlineWidgets } from '../cm/inlineWidgets';
import { livePreview } from '../cm/livePreview';
import { cmTheme } from '../cm/theme';
import { wikilinkExtensions } from '../cm/wikilinkPlugin';

export interface EditorPaneHandle {
  view: EditorView | null;
}

export interface EditorPaneProps {
  /** Read once at mount. Parents replace content by remounting with a new React `key`. */
  initialContent: string;
  onChange(text: string): void;
  onSave(): void;
  onOpenLink?(target: string): void;
  noteNames?: string[];
  resolveFile?(target: string): string | undefined;
}

export const EditorPane = forwardRef<EditorPaneHandle, EditorPaneProps>(function EditorPane(
  { initialContent, onChange, onSave, onOpenLink, noteNames, resolveFile },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const noteNamesRef = useRef(noteNames);
  noteNamesRef.current = noteNames;
  const resolveFileRef = useRef(resolveFile);
  resolveFileRef.current = resolveFile;

  useImperativeHandle(ref, () => ({
    get view() {
      return viewRef.current;
    },
  }), []);

  useEffect(() => {
    const extensions: Extension[] = [
      history(),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true; } },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
      cmTheme,
      livePreview,
      inlineWidgets({ resolveFile: (t) => resolveFileRef.current?.(t) }),
      blockWidgets,
    ];
    if (onOpenLinkRef.current) {
      extensions.push(
        ...wikilinkExtensions({
          onOpen: (t) => onOpenLinkRef.current?.(t),
          noteNames: () => noteNamesRef.current ?? [],
        }),
      );
    }
    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions,
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
