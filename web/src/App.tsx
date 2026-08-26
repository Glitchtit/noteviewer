import { useCallback, useEffect, useState } from 'react';
import type { TreeNode } from '@noteviewer/shared';
import { api, ApiError, onNetworkError } from './api';
import { ConflictBar } from './components/ConflictBar';
import { EditorPane } from './components/EditorPane';
import { FileTree } from './components/FileTree';
import { ReadingView } from './components/ReadingView';
import { useNoteEditor } from './hooks/useNoteEditor';
import { useVaultEvents } from './hooks/useVaultEvents';

type Naming = { mode: 'create' } | { mode: 'rename'; from: string } | null;

export function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [naming, setNaming] = useState<Naming>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'edit' | 'read'>('edit');
  const editor = useNoteEditor();
  const { path, title, content, revision, dirty, saving, conflict } = editor.state;

  const refreshTree = useCallback(() => {
    api.tree().then(setTree).catch(() => {});
  }, []);

  useEffect(() => {
    onNetworkError(() => setOffline(true));
    return () => onNetworkError(null);
  }, []);

  useEffect(() => {
    if (!offline) return;
    const id = setInterval(() => {
      api.tree().then((t) => {
        setTree(t);
        setOffline(false);
      }).catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, [offline]);

  useVaultEvents({
    onTreeChanged: refreshTree,
    onNoteChanged: (p) => void editor.external(p),
  });

  useEffect(() => refreshTree(), [refreshTree]);
  useEffect(() => setConfirmingDelete(false), [path]);

  // Ctrl/Cmd+E toggles reading mode globally. Flush any dirty buffer first
  // since editor.state.content only reflects the last-applied save, not
  // unsaved keystrokes — saveNow() closes that gap before ReadingView reads it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void editor.saveNow();
        setViewMode((m) => (m === 'edit' ? 'read' : 'edit'));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureMd = (name: string) => (name.endsWith('.md') ? name : `${name}.md`);

  async function submitName(value: string) {
    setActionError(null);
    const target = ensureMd(value);
    try {
      if (naming?.mode === 'create') {
        const res = await api.create(target);
        await editor.open(res.path);
      } else if (naming?.mode === 'rename') {
        await editor.saveNow();
        await api.rename(naming.from, target);
        await editor.open(target);
      }
      setNaming(null);
      refreshTree();
    } catch (err) {
      const message = err instanceof ApiError
        ? err.status === 409
          ? 'A note with that name already exists.'
          : `Operation failed (${err.status}).`
        : 'Operation failed.';
      setActionError(message);
    }
  }

  async function doDelete() {
    setActionError(null);
    if (!path) return;
    try {
      await api.remove(path);
      editor.clear();
      setConfirmingDelete(false);
      refreshTree();
    } catch (err) {
      const message = err instanceof ApiError
        ? `Operation failed (${err.status}).`
        : 'Operation failed.';
      setActionError(message);
      setConfirmingDelete(false);
    }
  }

  return (
    <div className={`app${sidebarOpen ? ' sidebar-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <button onClick={() => { setActionError(null); setNaming({ mode: 'create' }); }}>+ New</button>
        </div>
        {naming && (
          <NameInput
            initial={naming.mode === 'rename' ? naming.from : ''}
            onSubmit={(v) => void submitName(v)}
            onCancel={() => setNaming(null)}
          />
        )}
        {tree && <FileTree root={tree} selected={path} onOpenNote={(p) => void editor.open(p)} />}
      </aside>
      <main className="main">
        <header className="topbar">
          <button className="hamburger" aria-label="Toggle sidebar" onClick={() => setSidebarOpen((o) => !o)}>☰</button>
          <span className="title" data-testid="note-title">{path ? title : 'noteviewer'}</span>
          {path && (
            <>
              <button
                aria-label="Toggle reading mode"
                onClick={() => { void editor.saveNow(); setViewMode((m) => (m === 'edit' ? 'read' : 'edit')); }}
              >
                {viewMode === 'edit' ? 'Read' : 'Edit'}
              </button>
              <button onClick={() => { setActionError(null); setNaming({ mode: 'rename', from: path }); }}>Rename</button>
              {confirmingDelete ? (
                <button className="danger" onClick={() => void doDelete()}>Really delete?</button>
              ) : (
                <button onClick={() => setConfirmingDelete(true)}>Delete</button>
              )}
            </>
          )}
          <span className={`save-state${dirty ? ' dirty' : ''}`} data-testid="save-state">
            {saving ? 'Saving…' : dirty ? 'Edited' : path ? 'Saved' : ''}
          </span>
        </header>
        {offline && <div className="offline-banner">Vault unreachable — retrying…</div>}
        {actionError && <div className="offline-banner" role="alert" data-testid="action-error">{actionError}</div>}
        {conflict && (
          <ConflictBar
            onTheirs={editor.keepTheirs}
            onMine={() => void editor.keepMine()}
            onCopy={() => void editor.saveAsCopy()}
          />
        )}
        {path ? (
          viewMode === 'read' ? (
            <ReadingView content={content} tree={tree} onOpenNote={(p) => void editor.open(p)} />
          ) : (
            <EditorPane
              key={`${path}#${revision}`}
              initialContent={content}
              onChange={editor.handleChange}
              onSave={() => void editor.saveNow()}
            />
          )
        ) : (
          <div className="empty">Select a note</div>
        )}
      </main>
    </div>
  );
}

function NameInput({
  initial, onSubmit, onCancel,
}: {
  initial: string; onSubmit(v: string): void; onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="name-input"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <input
        autoFocus
        value={value}
        placeholder="path/note.md"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      />
    </form>
  );
}
