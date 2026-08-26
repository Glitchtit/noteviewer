import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../api';

export interface ConflictInfo {
  content: string;
  hash: string;
  mtimeMs: number;
}

export interface NoteEditorState {
  path: string | null;
  title: string;
  content: string;
  revision: number;
  dirty: boolean;
  saving: boolean;
  conflict: ConflictInfo | null;
  backlinks: string[];
}

const AUTOSAVE_MS = 1000;

const EMPTY: NoteEditorState = {
  path: null, title: '', content: '', revision: 0,
  dirty: false, saving: false, conflict: null, backlinks: [],
};

export function useNoteEditor() {
  const [state, setState] = useState<NoteEditorState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const bufferRef = useRef('');
  const baseHashRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
  }, [clearTimer]);

  const save = useCallback(async () => {
    const { path, dirty, conflict } = stateRef.current;
    if (!path || !dirty || conflict) return;
    clearTimer();
    const text = bufferRef.current;
    setState((s) => ({ ...s, saving: true }));
    try {
      const res = await api.save(path, text, baseHashRef.current);
      baseHashRef.current = res.hash;
      const stillDirty = bufferRef.current !== text;
      setState((s) => ({ ...s, saving: false, dirty: stillDirty }));
      if (stillDirty) schedule();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.body as { current: ConflictInfo }).current;
        setState((s) => ({ ...s, saving: false, conflict: current }));
      } else {
        // network or server hiccup: keep dirty, retry after another interval
        setState((s) => ({ ...s, saving: false }));
        schedule();
      }
    }
  }, [clearTimer, schedule]);
  saveRef.current = save;

  const open = useCallback(async (path: string) => {
    if (stateRef.current.dirty && !stateRef.current.conflict) await save();
    clearTimer();
    const note = await api.note(path);
    bufferRef.current = note.content;
    baseHashRef.current = note.meta.hash;
    setState((s) => ({
      path, title: note.meta.title, content: note.content, revision: s.revision + 1,
      dirty: false, saving: false, conflict: null, backlinks: note.backlinks,
    }));
  }, [clearTimer, save]);

  const handleChange = useCallback((text: string) => {
    bufferRef.current = text;
    setState((s) => (s.dirty ? s : { ...s, dirty: true }));
    schedule();
  }, [schedule]);

  const external = useCallback(async (path: string) => {
    if (path !== stateRef.current.path) return;
    const note = await api.note(path);
    if (note.meta.hash === baseHashRef.current) {
      // echo of our own save — refresh derived metadata only
      setState((s) => ({ ...s, title: note.meta.title, backlinks: note.backlinks }));
      return;
    }
    if (!stateRef.current.dirty) {
      bufferRef.current = note.content;
      baseHashRef.current = note.meta.hash;
      setState((s) => ({
        ...s, content: note.content, revision: s.revision + 1,
        title: note.meta.title, backlinks: note.backlinks, conflict: null,
      }));
    } else {
      setState((s) => ({
        ...s,
        conflict: { content: note.content, hash: note.meta.hash, mtimeMs: note.meta.mtimeMs },
      }));
    }
  }, []);

  const keepTheirs = useCallback(() => {
    const c = stateRef.current.conflict;
    if (!c) return;
    clearTimer();
    bufferRef.current = c.content;
    baseHashRef.current = c.hash;
    setState((s) => ({ ...s, content: c.content, revision: s.revision + 1, dirty: false, conflict: null }));
  }, [clearTimer]);

  const keepMine = useCallback(async () => {
    const { path, conflict } = stateRef.current;
    if (!path || !conflict) return;
    try {
      const res = await api.save(path, bufferRef.current, conflict.hash);
      baseHashRef.current = res.hash;
      setState((s) => ({ ...s, dirty: false, conflict: null }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.body as { current: ConflictInfo }).current;
        setState((s) => ({ ...s, conflict: current }));
      }
    }
  }, []);

  const saveAsCopy = useCallback(async () => {
    const { path } = stateRef.current;
    if (!path) return;
    clearTimer();
    const res = await api.create(path, bufferRef.current, true);
    baseHashRef.current = res.hash;
    const title = res.path.replace(/^.*\//, '').replace(/\.md$/, '');
    setState((s) => ({
      ...s, path: res.path, title, content: bufferRef.current, revision: s.revision + 1,
      dirty: false, conflict: null,
    }));
  }, [clearTimer]);

  const clear = useCallback(() => {
    clearTimer();
    bufferRef.current = '';
    baseHashRef.current = '';
    setState(EMPTY);
  }, [clearTimer]);

  return { state, open, handleChange, saveNow: save, external, keepTheirs, keepMine, saveAsCopy, clear };
}
