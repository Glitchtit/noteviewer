import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PROFILE_TEMPLATE, type AiStatus, type TreeNode } from '@noteviewer/shared';
import { api, ApiError, onNetworkError } from './api';
import { AiPanel, type ApplyMode } from './components/AiPanel';
import { ConflictBar } from './components/ConflictBar';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { EditorPane, type EditorPaneHandle } from './components/EditorPane';
import { ExportPdfDialog } from './components/ExportPdfDialog';
import { collectFolderPaths, FileTree } from './components/FileTree';
import { GraphView } from './components/GraphView';
import { KanbanBoard } from './components/KanbanBoard';
import { ReadingView } from './components/ReadingView';
import { RightPanel } from './components/RightPanel';
import { SearchOverlay } from './components/SearchOverlay';
import { useNoteEditor } from './hooks/useNoteEditor';
import { useVaultEvents } from './hooks/useVaultEvents';
import { exportPdf, type PdfOptions } from './exportPdf';
import { isKanbanNote } from './kanban';
import { resolveLink } from './resolveLink';

type Naming = { mode: 'create'; folder?: string } | { mode: 'rename'; from: string } | null;
type TreeMenu = { node: TreeNode; x: number; y: number } | null;
type PdfExport = { path: string; title: string } | null;

export function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [naming, setNaming] = useState<Naming>(null);
  const [treeMenu, setTreeMenu] = useState<TreeMenu>(null);
  const closeTreeMenu = useCallback(() => setTreeMenu(null), []);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  const [viewMode, setViewMode] = useState<'edit' | 'read'>('edit');
  const [boardMode, setBoardMode] = useState(true);
  const [overlay, setOverlay] = useState<'switcher' | 'search' | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [pdfExport, setPdfExport] = useState<PdfExport>(null);
  const closePdfExport = useCallback(() => setPdfExport(null), []);
  // Incremented on every vault event; GraphView debounces and refetches.
  const [graphVersion, setGraphVersion] = useState(0);
  const editorRef = useRef<EditorPaneHandle>(null);
  const editor = useNoteEditor();
  const { path, title, revision, dirty, saving, conflict } = editor.state;
  const kanban = isKanbanNote(editor.getBuffer());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  async function openNote(p: string) {
    setActionError(null);
    try {
      await editor.open(p);
    } catch {
      setActionError('Failed to open note.');
    }
  }

  const refreshTree = useCallback(() => {
    api.tree().then(setTree).catch(() => {});
  }, []);

  const noteNames = useMemo(() => {
    const out: string[] = [];
    const walk = (n: TreeNode) => {
      if (n.type === 'note') out.push(n.path.replace(/\.md$/, ''));
      (n.children ?? []).forEach(walk);
    };
    if (tree) walk(tree);
    return out;
  }, [tree]);

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
    onTreeChanged: () => { refreshTree(); setGraphVersion((v) => v + 1); },
    onNoteChanged: (p) => { void editor.external(p); setGraphVersion((v) => v + 1); },
  });

  useEffect(() => refreshTree(), [refreshTree]);
  // profileExists tracks the vault, so re-check whenever the tree changes
  useEffect(() => {
    if (aiOpen) api.aiStatus().then(setAiStatus).catch(() => {});
  }, [aiOpen, tree]);
  useEffect(() => setConfirmingDelete(false), [path]);
  useEffect(() => setBoardMode(true), [path]);
  // Opening any note (tree, switcher, graph node, create) leaves the graph.
  useEffect(() => setGraphOpen(false), [path]);

  // Ctrl/Cmd+E toggles reading mode globally. state.content is only the
  // last-applied snapshot (set by open/external/keepTheirs/saveAsCopy) — it
  // does not reflect in-progress keystrokes, so ReadingView is fed from the
  // live edit buffer via editor.getBuffer() instead. saveNow() here is for
  // persistence (so the edit isn't lost), not for freshening what's read.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void editor.saveNow();
        setViewMode((m) => (m === 'edit' ? 'read' : 'edit'));
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOverlay('switcher');
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOverlay('search');
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setAiOpen((o) => !o);
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        setGraphOpen((g) => !g);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flush a dirty save when the tab is backgrounded/closed, and warn before
  // an unload that would lose unsaved edits. Registered once; dirtyRef keeps
  // the beforeunload handler reading the current dirty flag without needing
  // to re-register on every dirty-state change.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        void editor.saveNow();
      }
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (dirtyRef.current) {
        e.preventDefault();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
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
        await renameNote(naming.from, target);
      }
      setNaming(null);
      refreshTree();
    } catch (err) {
      showMutationError(err);
    }
  }

  // Flushes pending edits first so the rename moves the latest content, and
  // follows the note to its new path when it's the one open in the editor.
  async function renameNote(from: string, to: string) {
    await editor.saveNow();
    await api.rename(from, to);
    if (from === path) await editor.open(to);
  }

  function showMutationError(err: unknown) {
    setActionError(err instanceof ApiError
      ? err.status === 409
        ? 'A note with that name already exists.'
        : `Operation failed (${err.status}).`
      : 'Operation failed.');
  }

  async function moveNote(from: string, toFolder: string) {
    setActionError(null);
    const name = from.slice(from.lastIndexOf('/') + 1);
    try {
      await renameNote(from, toFolder ? `${toFolder}/${name}` : name);
      if (toFolder) setExpandedFolders((prev) => new Set(prev).add(toFolder));
      refreshTree();
    } catch (err) {
      showMutationError(err);
    }
  }

  async function copyNote(p: string) {
    setActionError(null);
    try {
      if (p === path) await editor.saveNow();
      const { content } = await api.note(p);
      const res = await api.create(p, content, true);
      refreshTree();
      await editor.open(res.path);
    } catch (err) {
      showMutationError(err);
    }
  }

  function treeMenuItems(node: TreeNode): ContextMenuItem[] {
    if (node.type === 'note') {
      return [
        { label: 'Open', onSelect: () => { setSidebarOpen(false); void openNote(node.path); } },
        { label: 'Create copy', onSelect: () => void copyNote(node.path) },
        { label: 'Export to PDF', onSelect: () => setPdfExport({ path: node.path, title: noteTitle(node.path) }) },
        { label: 'Rename', onSelect: () => { setActionError(null); setNaming({ mode: 'rename', from: node.path }); } },
        { label: 'Delete', danger: true, confirmLabel: 'Really delete?', onSelect: () => void doDelete(node.path) },
      ];
    }
    return [
      {
        label: node.path ? 'New note here' : 'New note',
        onSelect: () => { setActionError(null); setNaming({ mode: 'create', folder: node.path || undefined }); },
      },
    ];
  }

  async function openFromGraph(p: string) {
    setGraphOpen(false);
    await openNote(p);
  }

  async function createFromGraph(name: string) {
    setActionError(null);
    try {
      const res = await api.create(ensureMd(name));
      setGraphOpen(false);
      await editor.open(res.path);
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

  function editorSelection(): string {
    const view = editorRef.current?.view;
    if (!view) return '';
    const { from, to } = view.state.selection.main;
    return view.state.sliceDoc(from, to);
  }

  // Apply AI output to the note. In the editor this is a normal CodeMirror
  // transaction (undoable, flows through onChange); elsewhere (reading or
  // board view) there's no cursor, so insert degrades to append.
  function applyAi(mode: ApplyMode, text: string) {
    const view = editorRef.current?.view;
    if (view && !(kanban && boardMode) && viewMode === 'edit') {
      const doc = view.state.doc;
      const { from, to } = view.state.selection.main;
      const changes =
        mode === 'append'
          ? { from: doc.length, insert: `${blockSeparator(doc.toString())}${text}` }
          : mode === 'replace' && from === to
            ? { from: 0, to: doc.length, insert: text }
            : { from, to, insert: text };
      view.dispatch({ changes, scrollIntoView: true });
      view.focus();
      return;
    }
    const buf = editor.getBuffer();
    if (mode === 'replace') {
      editor.applyLocalContent(text);
    } else {
      editor.applyLocalContent(`${buf}${blockSeparator(buf)}${text}`);
    }
  }

  async function openAiProfile() {
    if (!aiStatus) return;
    setActionError(null);
    try {
      if (!aiStatus.profileExists) {
        await api.create(aiStatus.profileNote, PROFILE_TEMPLATE);
        refreshTree();
      }
      setGraphOpen(false);
      await editor.open(aiStatus.profileNote);
    } catch {
      setActionError('Failed to open the AI profile note.');
    }
  }

  async function doExportPdf(target: string, opts: PdfOptions) {
    setPdfExport(null);
    setActionError(null);
    try {
      if (target === path) {
        await editor.saveNow();
        await exportPdf(title, editor.getBuffer(), tree, opts);
      } else {
        const note = await api.note(target);
        await exportPdf(note.meta.title, note.content, tree, opts);
      }
    } catch {
      setActionError('PDF export failed.');
    }
  }

  async function doDelete(target = path) {
    setActionError(null);
    if (!target) return;
    try {
      await api.remove(target);
      if (target === path) editor.clear();
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
          <div className="tree-tools">
            <button
              title="Expand all folders"
              aria-label="Expand all folders"
              onClick={() => { if (tree) setExpandedFolders(new Set(collectFolderPaths(tree))); }}
            >
              ▾▾
            </button>
            <button
              title="Collapse all folders"
              aria-label="Collapse all folders"
              onClick={() => setExpandedFolders(new Set())}
            >
              ▸▸
            </button>
          </div>
        </div>
        {naming && (
          <NameInput
            key={naming.mode === 'rename' ? `rename:${naming.from}` : `create:${naming.folder ?? ''}`}
            initial={naming.mode === 'rename' ? naming.from : naming.folder ? `${naming.folder}/` : ''}
            onSubmit={(v) => void submitName(v)}
            onCancel={() => setNaming(null)}
          />
        )}
        {tree && (
          <FileTree
            root={tree}
            selected={path}
            expanded={expandedFolders}
            onOpenNote={(p) => { setSidebarOpen(false); void openNote(p); }}
            onToggleFolder={(p) => {
              setExpandedFolders((prev) => {
                const next = new Set(prev);
                if (next.has(p)) next.delete(p); else next.add(p);
                return next;
              });
            }}
            onContextMenu={(node, x, y) => setTreeMenu({ node, x, y })}
            onMoveNote={(from, to) => void moveNote(from, to)}
          />
        )}
        {treeMenu && (
          <ContextMenu
            x={treeMenu.x}
            y={treeMenu.y}
            items={treeMenuItems(treeMenu.node)}
            onClose={closeTreeMenu}
          />
        )}
      </aside>
      <main className="main">
        <header className="topbar">
          <button className="hamburger" aria-label="Toggle sidebar" onClick={() => setSidebarOpen((o) => !o)}>☰</button>
          <span className="title" data-testid="note-title">{graphOpen ? 'Graph' : path ? title : 'noteviewer'}</span>
          <button
            aria-label="Toggle graph view"
            aria-pressed={graphOpen}
            title="Graph view (Ctrl+G)"
            onClick={() => { void editor.saveNow(); setGraphOpen((g) => !g); }}
          >
            {graphOpen ? 'Close graph' : 'Graph'}
          </button>
          <button
            aria-label="Toggle AI panel"
            aria-pressed={aiOpen}
            title="AI assistant (Ctrl+J)"
            onClick={() => setAiOpen((o) => !o)}
          >
            AI
          </button>
          {path && !graphOpen && (
            <>
              <button
                aria-label="Toggle reading mode"
                onClick={() => { void editor.saveNow(); setViewMode((m) => (m === 'edit' ? 'read' : 'edit')); }}
              >
                {viewMode === 'edit' ? 'Read' : 'Edit'}
              </button>
              <button aria-label="Toggle right panel" onClick={() => setPanelOpen((o) => !o)}>
                Panel
              </button>
              {kanban && (
                <button aria-label="Toggle board view" onClick={() => setBoardMode((b) => !b)}>
                  {boardMode ? 'Raw' : 'Board'}
                </button>
              )}
              <button aria-label="Export PDF" title="Export to PDF" onClick={() => setPdfExport({ path, title })}>
                PDF
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
        {graphOpen ? (
          <GraphView
            currentPath={path}
            refreshKey={graphVersion}
            onOpenNote={(p) => void openFromGraph(p)}
            onCreateNote={(n) => void createFromGraph(n)}
          />
        ) : path ? (
          kanban && boardMode ? (
            <KanbanBoard content={editor.getBuffer()} onChange={(md) => editor.applyLocalContent(md)} />
          ) : viewMode === 'read' ? (
            <ReadingView content={editor.getBuffer()} tree={tree} onOpenNote={(p) => void openNote(p)} />
          ) : (
            <EditorPane
              ref={editorRef}
              key={`${path}#${revision}`}
              initialContent={editor.getBuffer()}
              onChange={editor.handleChange}
              onSave={() => void editor.saveNow()}
              onOpenLink={(t) => { const r = tree && resolveLink(tree, t); if (r) void openNote(r); }}
              noteNames={noteNames}
              resolveFile={(t) => (tree ? resolveLink(tree, t) : undefined)}
            />
          )
        ) : (
          <div className="empty">Select a note</div>
        )}
      </main>
      {panelOpen && (
        <RightPanel
          backlinks={editor.state.backlinks}
          headings={editor.state.headings}
          onOpenNote={(p) => void openNote(p)}
          onJumpToHeading={(h) => {
            const view = editorRef.current?.view;
            if (!view) return;
            const re = new RegExp(`^#{${h.level}}\\s+${h.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
            for (let i = 1; i <= view.state.doc.lines; i++) {
              const line = view.state.doc.line(i);
              if (re.test(line.text)) {
                view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
                view.focus();
                break;
              }
            }
          }}
        />
      )}
      {aiOpen && (
        <AiPanel
          status={aiStatus}
          path={path}
          getContent={editor.getBuffer}
          getSelection={editorSelection}
          onApply={applyAi}
          onOpenProfile={() => void openAiProfile()}
          onClose={() => setAiOpen(false)}
        />
      )}
      {pdfExport && (
        <ExportPdfDialog
          title={pdfExport.title}
          onExport={(opts) => void doExportPdf(pdfExport.path, opts)}
          onClose={closePdfExport}
        />
      )}
      {overlay && (
        <SearchOverlay
          mode={overlay}
          notePaths={noteNames.map((n) => `${n}.md`)}
          onOpen={(p) => { setOverlay(null); void openNote(p); }}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  );
}

function noteTitle(p: string): string {
  return (p.split('/').pop() ?? p).replace(/\.md$/i, '');
}

/** Newlines needed after `text` so appended content starts a new Markdown block. */
function blockSeparator(text: string): string {
  if (!text || text.endsWith('\n\n')) return '';
  return text.endsWith('\n') ? '\n' : '\n\n';
}

function NameInput({
  initial, onSubmit, onCancel,
}: {
  initial: string; onSubmit(v: string): void; onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Pre-select the note's name (not its folder or .md) so typing replaces it.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const start = initial.lastIndexOf('/') + 1;
    const end = initial.endsWith('.md') ? initial.length - 3 : initial.length;
    el.setSelectionRange(start, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <form
      className="name-input"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <input
        ref={inputRef}
        autoFocus
        value={value}
        placeholder="path/note.md"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      />
    </form>
  );
}
