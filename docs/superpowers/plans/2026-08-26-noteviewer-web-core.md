# Noteviewer Web Core Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `web/` placeholder with the real noteviewer SPA: dark Obsidian-style shell, file tree, CodeMirror 6 markdown editor, debounced autosave with the hash conflict guard, the three-option conflict bar (load theirs / overwrite / save as copy), SSE live updates with echo suppression, offline banner, mobile drawer, and Playwright e2e tests wired into CI.

**Architecture:** Vite + React 19 + TypeScript in `web/`, talking to the Plan-1 Fastify API (`/api/*`) — via Vite dev proxy in development, same-origin in production (server already serves `web/dist` with SPA fallback). State is plain React hooks; the save/conflict state machine lives in one testable hook (`useNoteEditor`). CodeMirror is wrapped in one component remounted via React `key` when content is replaced externally. Rich live-preview rendering is Plan 3 — this plan ships a plain (but themed) markdown editor.

**Tech Stack:** React 19, Vite 6, CodeMirror 6 (`@codemirror/lang-markdown`), Vitest 3 (projects: node + jsdom), @testing-library/react, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-26-noteviewer-design.md`

## Global Constraints

- **Dark mode only.** No light theme, no toggle, no `prefers-color-scheme` anywhere. All colors come from the CSS custom properties defined in `web/src/theme.css` (Task 1).
- TypeScript strict everywhere; `import type` for anything from `@noteviewer/shared`.
- No authentication anywhere in the app (Cloudflare Access owns auth).
- Autosave: debounced **1000 ms** after last change; Ctrl/Cmd+S forces immediate save; a visible save-state indicator (`data-testid="save-state"`: `Saving…` / `Edited` / `Saved`).
- Conflict UX is exactly three options: **Load theirs / Overwrite with mine / Save as copy** — save-as-copy uses `POST /api/note` with `unique: true` and switches the editor to the returned path. Never fewer options, never a blocking `window.confirm`/`alert`/`prompt` anywhere in the app (breaks automation and UX; use inline inputs and two-click confirm patterns).
- Echo suppression: on an SSE `note-changed` for the open note, refetch; if the fetched hash equals the editor's current base hash, it is our own save echoing back — do not touch the buffer.
- Server API shapes are fixed by Plan 1 (shared types + routes); do not modify anything under `server/` except where a task explicitly says so (Task 10 touches CI config only).
- Run unit tests from the repo root with `npx vitest run` (or filtered: `npx vitest run --project web`); typecheck with `npm run typecheck`.
- No AI co-author trailers in commits.

---

### Task 1: Vite + React scaffold, dark theme, app shell

**Files:**
- Replace: `web/package.json`, `web/index.html`
- Create: `web/vite.config.ts`, `web/tsconfig.json`, `web/src/main.tsx`, `web/src/App.tsx` (placeholder shell), `web/src/theme.css`, `web/test/setup.ts`
- Modify: `vitest.config.ts` (projects), `package.json` (root: typecheck script + test devDeps), `.gitignore`
- Test: `web/test/app.test.tsx` (smoke)

**Interfaces:**
- Consumes: nothing new
- Produces: `npm run build -w web` emits a real Vite build to `web/dist` (Dockerfile already copies it); `npx vitest run` runs both `server` and `web` projects; `web/src/theme.css` defines the class contract all later tasks use: `.app`, `.sidebar`, `.sidebar-header`, `.main`, `.topbar`, `.title`, `.filetree`, `.tree-item`, `.tree-folder`, `.tree-note`, `.tree-file`, `.tree-chevron`, `.selected`, `.editor`, `.empty`, `.save-state`, `.dirty`, `.name-input`, `.conflict-bar`, `.conflict-actions`, `.offline-banner`, `.hamburger`, `.sidebar-open`, `button.primary`, `button.danger`

- [ ] **Step 1: Write the smoke test**

`web/test/app.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

describe('App shell', () => {
  it('renders the shell', () => {
    render(<App />);
    expect(screen.getByText('noteviewer')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run --project web`
Expected: fails — no web project / modules missing.

- [ ] **Step 3: Create the workspace files**

`web/package.json`:
```json
{
  "name": "web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "@codemirror/commands": "^6.7.0",
    "@codemirror/lang-markdown": "^6.3.0",
    "@codemirror/language": "^6.10.0",
    "@codemirror/state": "^6.4.0",
    "@codemirror/view": "^6.34.0",
    "@lezer/highlight": "^1.2.0",
    "@noteviewer/shared": "*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0"
  }
}
```

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>noteviewer</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8080' },
  },
});
```

`web/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src", "test", "../shared/src"]
}
```

`web/src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme.css';

createRoot(document.getElementById('root')!).render(<App />);
```

`web/src/App.tsx` (placeholder — Task 6 replaces it):
```tsx
export function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">noteviewer</div>
      </aside>
      <main className="main">
        <div className="empty">Select a note</div>
      </main>
    </div>
  );
}
```

`web/src/theme.css` — the complete stylesheet; later tasks only USE these classes, they never add CSS:
```css
:root {
  --bg: #1e1e1e;
  --bg-deep: #161616;
  --bg-hover: #2a2a2a;
  --bg-active: #363636;
  --text: #dcddde;
  --text-muted: #8a8a8a;
  --accent: #8b7cf6;
  --border: #333;
  --danger: #e05252;
  --warn: #d8a03c;
}

* { box-sizing: border-box; }

html, body, #root { height: 100%; margin: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  font-size: 15px;
}

.app { display: flex; height: 100%; }

.sidebar {
  width: 260px;
  flex-shrink: 0;
  background: var(--bg-deep);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.sidebar-header { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--border); }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

.topbar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
.topbar .title { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

button { background: none; border: none; color: var(--text); font: inherit; cursor: pointer; border-radius: 4px; padding: 4px 10px; }
button:hover { background: var(--bg-hover); }
button.primary { background: var(--accent); color: #fff; }
button.primary:hover { filter: brightness(1.1); }
button.danger { color: var(--danger); }

.filetree { padding: 6px 0; flex: 1; }
.tree-item {
  display: block; width: 100%; text-align: left; padding: 3px 8px;
  border-radius: 0; color: var(--text-muted); text-decoration: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tree-item:hover { background: var(--bg-hover); color: var(--text); }
.tree-note.selected { background: var(--bg-active); color: var(--text); }
.tree-chevron { display: inline-block; width: 14px; color: var(--text-muted); }

.editor { flex: 1; overflow: auto; }
.cm-editor { height: 100%; }

.empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-muted); }

.save-state { color: var(--text-muted); font-size: 12px; min-width: 48px; text-align: right; }
.save-state.dirty { color: var(--warn); }

.name-input { padding: 8px; }
.name-input input {
  width: 100%; background: var(--bg); color: var(--text);
  border: 1px solid var(--accent); border-radius: 4px; padding: 6px 8px; font: inherit;
}

.conflict-bar {
  display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  background: #3a2f1e; border-bottom: 1px solid var(--warn);
}
.conflict-actions { display: flex; gap: 8px; margin-left: auto; }
.conflict-bar button { border: 1px solid var(--border); }

.offline-banner { padding: 8px 16px; background: #3a1e1e; border-bottom: 1px solid var(--danger); color: #f0b0b0; }

.hamburger { display: none; }

@media (max-width: 768px) {
  .hamburger { display: block; }
  .sidebar {
    position: fixed; inset: 0 auto 0 0; z-index: 10; width: 280px;
    transform: translateX(-100%); transition: transform 0.2s;
  }
  .app.sidebar-open .sidebar { transform: translateX(0); box-shadow: 0 0 24px rgba(0, 0, 0, 0.5); }
}
```

`web/test/setup.ts` (jsdom lacks the layout APIs CodeMirror probes):
```ts
const rect = {
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
  toJSON: () => ({}),
} as DOMRect;

Range.prototype.getBoundingClientRect = () => rect;
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: Array.prototype[Symbol.iterator] }) as unknown as DOMRectList;

if (!document.elementFromPoint) {
  (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;
}

// jsdom has no EventSource; App mounts one. Tests that care stub their own via vi.stubGlobal.
class StubEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  close(): void {}
}
if (!('EventSource' in globalThis)) {
  (globalThis as Record<string, unknown>).EventSource = StubEventSource;
}
```

Replace `vitest.config.ts` (root):
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web',
          environment: 'jsdom',
          environmentOptions: { jsdom: { pretendToBeVisual: true } },
          include: ['web/test/**/*.test.{ts,tsx}'],
          setupFiles: ['web/test/setup.ts'],
        },
      },
    ],
  },
});
```

Root `package.json` edits: in `devDependencies` add
```json
    "@testing-library/dom": "^10.4.0",
    "@testing-library/react": "^16.0.0",
    "jsdom": "^26.0.0",
```
and change the typecheck script to
```json
    "typecheck": "tsc -p server --noEmit && tsc -p web --noEmit",
```

`.gitignore`: append
```
e2e/.vault/
test-results/
playwright-report/
```

- [ ] **Step 4: Install, test, build**

Run: `npm install && npx vitest run && npm run typecheck && npm run build -w web`
Expected: all server tests + the new web smoke test pass; typecheck clean; `web/dist/index.html` exists.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): vite+react scaffold with dark shell and vitest web project"
```

---

### Task 2: API client

**Files:**
- Create: `web/src/api.ts`
- Test: `web/test/api.test.ts`

**Interfaces:**
- Consumes: shared types (`import type`)
- Produces (all later tasks import these exact names from `../src/api` / `./api`):
  - `class ApiError extends Error { status: number; body?: unknown }` — `status === 0` means network failure
  - `encodePath(p: string): string` — per-segment `encodeURIComponent`, `/` preserved
  - `api.tree(): Promise<TreeNode>`
  - `api.note(path: string): Promise<NoteResponse>`
  - `api.save(path: string, content: string, baseHash: string): Promise<{ mtimeMs: number; hash: string }>` — throws `ApiError` 409 whose `body` is `{ current: { content, mtimeMs, hash } }`
  - `api.create(path: string, content?: string, unique?: boolean): Promise<{ path: string; mtimeMs: number; hash: string }>`
  - `api.remove(path: string): Promise<{ trashedTo: string }>`
  - `api.rename(from: string, to: string): Promise<{ rewritten: string[] }>`
  - `api.search(q: string): Promise<SearchResult[]>`
  - `onNetworkError(fn: (() => void) | null): void` — registers a single listener invoked whenever a request fails at the network level (Task 9 uses it)

- [ ] **Step 1: Write the failing tests**

`web/test/api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, encodePath, onNetworkError } from '../src/api';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  fetchMock.mockReset();
  onNetworkError(null);
});

describe('api client', () => {
  it('encodes path segments but keeps slashes', () => {
    expect(encodePath('sub dir/no te.md')).toBe('sub%20dir/no%20te.md');
  });

  it('GETs a note from the right URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { content: 'x' }));
    await api.note('sub/a b.md');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/note/sub/a%20b.md');
  });

  it('PUTs saves with content and baseHash', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { mtimeMs: 1, hash: 'h2' }));
    const res = await api.save('a.md', 'new', 'h1');
    expect(res.hash).toBe('h2');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ content: 'new', baseHash: 'h1' });
  });

  it('throws ApiError with body on 409', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { current: { content: 'disk', mtimeMs: 2, hash: 'hd' } }),
    );
    const err = await api.save('a.md', 'mine', 'stale').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.body.current.content).toBe('disk');
  });

  it('throws ApiError status 0 and notifies listener on network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const listener = vi.fn();
    onNetworkError(listener);
    const err = await api.tree().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('creates with unique flag', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { path: 'n-copy.md', mtimeMs: 1, hash: 'h' }));
    const res = await api.create('n.md', 'body', true);
    expect(res.path).toBe('n-copy.md');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      path: 'n.md',
      content: 'body',
      unique: true,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project web`
Expected: FAIL — `../src/api` not found.

- [ ] **Step 3: Implement**

`web/src/api.ts`:
```ts
import type { NoteResponse, SearchResult, TreeNode } from '@noteviewer/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

let networkErrorListener: (() => void) | null = null;

export function onNetworkError(fn: (() => void) | null): void {
  networkErrorListener = fn;
}

export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    networkErrorListener?.();
    throw new ApiError(0, 'network error', err);
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, `request failed: ${res.status}`, body);
  return body as T;
}

export const api = {
  tree: () => request<TreeNode>('/api/tree'),
  note: (path: string) => request<NoteResponse>(`/api/note/${encodePath(path)}`),
  save: (path: string, content: string, baseHash: string) =>
    request<{ mtimeMs: number; hash: string }>(`/api/note/${encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content, baseHash }),
    }),
  create: (path: string, content = '', unique = false) =>
    request<{ path: string; mtimeMs: number; hash: string }>('/api/note', {
      method: 'POST',
      body: JSON.stringify({ path, content, unique }),
    }),
  remove: (path: string) =>
    request<{ trashedTo: string }>(`/api/note/${encodePath(path)}`, { method: 'DELETE' }),
  rename: (from: string, to: string) =>
    request<{ rewritten: string[] }>('/api/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
  search: (q: string) => request<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project web` — 7 web tests PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/test/api.test.ts
git commit -m "feat(web): typed API client with network-error signaling"
```

---

### Task 3: File tree component

**Files:**
- Create: `web/src/components/FileTree.tsx`
- Test: `web/test/filetree.test.tsx`

**Interfaces:**
- Consumes: `TreeNode` (shared, `import type`), `encodePath` (Task 2)
- Produces: `FileTree({ root, selected, onOpenNote }: { root: TreeNode; selected: string | null; onOpenNote(path: string): void })` — folders are collapsible buttons (default expanded), notes are buttons labeled without `.md` that call `onOpenNote(path)`, attachments are `<a target="_blank">` links to `/api/file/<encoded>`

- [ ] **Step 1: Write the failing tests**

`web/test/filetree.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '@noteviewer/shared';
import { FileTree } from '../src/components/FileTree';

const fixture: TreeNode = {
  name: '', path: '', type: 'folder',
  children: [
    {
      name: 'sub', path: 'sub', type: 'folder',
      children: [{ name: 'inner.md', path: 'sub/inner.md', type: 'note' }],
    },
    { name: 'a.md', path: 'a.md', type: 'note' },
    { name: 'img.png', path: 'img.png', type: 'file' },
  ],
};

describe('FileTree', () => {
  it('renders notes without .md and calls onOpenNote', () => {
    const onOpen = vi.fn();
    render(<FileTree root={fixture} selected={null} onOpenNote={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onOpen).toHaveBeenCalledWith('a.md');
  });

  it('collapses and expands folders', () => {
    render(<FileTree root={fixture} selected={null} onOpenNote={() => {}} />);
    expect(screen.getByRole('button', { name: 'inner' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /sub/ }));
    expect(screen.queryByRole('button', { name: 'inner' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /sub/ }));
    expect(screen.getByRole('button', { name: 'inner' })).toBeTruthy();
  });

  it('links attachments to /api/file and marks the selected note', () => {
    render(<FileTree root={fixture} selected="a.md" onOpenNote={() => {}} />);
    const link = screen.getByRole('link', { name: 'img.png' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/file/img.png');
    expect(screen.getByRole('button', { name: 'a' }).className).toContain('selected');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project web`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`web/src/components/FileTree.tsx`:
```tsx
import { useState } from 'react';
import type { TreeNode } from '@noteviewer/shared';
import { encodePath } from '../api';

export interface FileTreeProps {
  root: TreeNode;
  selected: string | null;
  onOpenNote(path: string): void;
}

export function FileTree({ root, selected, onOpenNote }: FileTreeProps) {
  return (
    <div className="filetree">
      {(root.children ?? []).map((n) => (
        <TreeEntry key={n.path} node={n} selected={selected} onOpenNote={onOpenNote} depth={0} />
      ))}
    </div>
  );
}

function TreeEntry({
  node, selected, onOpenNote, depth,
}: {
  node: TreeNode; selected: string | null; onOpenNote(p: string): void; depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pad = { paddingLeft: `${8 + depth * 14}px` };

  if (node.type === 'folder') {
    return (
      <div>
        <button className="tree-item tree-folder" style={pad} onClick={() => setCollapsed((c) => !c)}>
          <span className="tree-chevron">{collapsed ? '▸' : '▾'}</span>
          {node.name}
        </button>
        {!collapsed &&
          (node.children ?? []).map((c) => (
            <TreeEntry key={c.path} node={c} selected={selected} onOpenNote={onOpenNote} depth={depth + 1} />
          ))}
      </div>
    );
  }

  if (node.type === 'note') {
    return (
      <button
        className={`tree-item tree-note${selected === node.path ? ' selected' : ''}`}
        style={pad}
        onClick={() => onOpenNote(node.path)}
      >
        {node.name.replace(/\.md$/, '')}
      </button>
    );
  }

  return (
    <a
      className="tree-item tree-file"
      style={pad}
      href={`/api/file/${encodePath(node.path)}`}
      target="_blank"
      rel="noreferrer"
    >
      {node.name}
    </a>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project web` — PASS. `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FileTree.tsx web/test/filetree.test.tsx
git commit -m "feat(web): collapsible file tree"
```

---

### Task 4: CodeMirror editor pane

**Files:**
- Create: `web/src/cm/theme.ts`, `web/src/components/EditorPane.tsx`
- Test: `web/test/editorpane.test.tsx`

**Interfaces:**
- Consumes: nothing project-specific
- Produces:
  - `cmTheme: Extension[]` (dark editor theme + markdown syntax highlighting)
  - `EditorPane` — `forwardRef` component: props `{ initialContent: string; onChange(text: string): void; onSave(): void }`, ref handle `{ view: EditorView | null }`. `initialContent` is read once at mount — the parent replaces content by remounting via React `key` (documented in the component). Ctrl/Cmd+S triggers `onSave`. Callbacks are held in refs so stale closures are impossible.

- [ ] **Step 1: Write the failing tests**

`web/test/editorpane.test.tsx`:
```tsx
import { createRef } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorPane, type EditorPaneHandle } from '../src/components/EditorPane';

describe('EditorPane', () => {
  it('mounts CodeMirror with the initial content', () => {
    const ref = createRef<EditorPaneHandle>();
    render(<EditorPane ref={ref} initialContent="# Hello" onChange={() => {}} onSave={() => {}} />);
    expect(ref.current?.view?.state.doc.toString()).toBe('# Hello');
  });

  it('reports document changes through onChange', () => {
    const ref = createRef<EditorPaneHandle>();
    const onChange = vi.fn();
    render(<EditorPane ref={ref} initialContent="a" onChange={onChange} onSave={() => {}} />);
    ref.current!.view!.dispatch({ changes: { from: 1, insert: 'bc' } });
    expect(onChange).toHaveBeenLastCalledWith('abc');
  });

  it('destroys the view on unmount', () => {
    const ref = createRef<EditorPaneHandle>();
    const { unmount } = render(
      <EditorPane ref={ref} initialContent="" onChange={() => {}} onSave={() => {}} />,
    );
    const handle = ref.current!; // React nulls ref.current on unmount — capture the handle first
    unmount();
    expect(handle.view).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project web`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`web/src/cm/theme.ts`:
```ts
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
```

`web/src/components/EditorPane.tsx`:
```tsx
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project web` — PASS. `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/cm/theme.ts web/src/components/EditorPane.tsx web/test/editorpane.test.tsx
git commit -m "feat(web): CodeMirror 6 markdown editor pane with dark theme"
```

---

### Task 5: useNoteEditor hook (save/conflict state machine)

**Files:**
- Create: `web/src/hooks/useNoteEditor.ts`
- Test: `web/test/useNoteEditor.test.ts`

**Interfaces:**
- Consumes: `api`, `ApiError` (Task 2)
- Produces `useNoteEditor(): NoteEditor` where:
```ts
interface ConflictInfo { content: string; hash: string; mtimeMs: number }
interface NoteEditorState {
  path: string | null;
  title: string;
  content: string;      // last applied content — NOT live keystrokes
  revision: number;     // parents key the EditorPane on `${path}#${revision}`
  dirty: boolean;
  saving: boolean;
  conflict: ConflictInfo | null;
  backlinks: string[];
}
interface NoteEditor {
  state: NoteEditorState;
  open(path: string): Promise<void>;        // flushes a pending dirty save first
  handleChange(text: string): void;         // schedules autosave (1000 ms)
  saveNow(): Promise<void>;                 // Ctrl+S / immediate save
  external(path: string): Promise<void>;    // SSE note-changed entry point (echo-suppressing)
  keepTheirs(): void;
  keepMine(): Promise<void>;
  saveAsCopy(): Promise<void>;
  clear(): void;                            // after delete
}
```
Behavioral contract (each bullet is a test):
  - autosave fires 1000 ms after the last `handleChange`; save PUTs the live buffer with the stored base hash; success clears `dirty` and updates the base hash
  - a 409 on save sets `conflict` to the response's `current` and stops autosaving until resolved (`saveNow` no-ops while a conflict is open)
  - a network error on save keeps `dirty` and reschedules
  - `external`: same hash as base → echo → buffer untouched (only title/backlinks refresh); clean buffer → content applied + `revision` bump; dirty buffer → `conflict` set
  - `keepTheirs` applies the disk version (revision bump, not dirty); `keepMine` PUTs the buffer with the CONFLICT hash as base; `saveAsCopy` POSTs `unique: true` and switches `path` to the returned copy path (title = copy basename without `.md`, not dirty)
  - `open` on a dirty note saves it before loading the next

- [ ] **Step 1: Write the failing tests**

`web/test/useNoteEditor.test.ts`:
```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNoteEditor } from '../src/hooks/useNoteEditor';
import { api, ApiError } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      tree: vi.fn(),
      note: vi.fn(),
      save: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      search: vi.fn(),
    },
  };
});

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function noteResponse(content: string, hash: string, title = 'T') {
  return {
    content,
    backlinks: ['ref.md'],
    meta: { path: 'a.md', title, tags: [], links: [], headings: [], mtimeMs: 1, hash },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(mocked).forEach((fn) => fn.mockReset());
});
afterEach(() => {
  vi.useRealTimers();
});

async function openNote(hash = 'h1', content = 'body') {
  mocked.note!.mockResolvedValue(noteResponse(content, hash));
  const hook = renderHook(() => useNoteEditor());
  await act(() => hook.result.current.open('a.md'));
  return hook;
}

describe('useNoteEditor', () => {
  it('open loads content, hash, backlinks', async () => {
    const { result } = await openNote();
    expect(result.current.state.path).toBe('a.md');
    expect(result.current.state.content).toBe('body');
    expect(result.current.state.dirty).toBe(false);
    expect(result.current.state.backlinks).toEqual(['ref.md']);
  });

  it('autosaves 1000ms after the last change with the base hash', async () => {
    const { result } = await openNote();
    mocked.save!.mockResolvedValue({ mtimeMs: 2, hash: 'h2' });
    act(() => result.current.handleChange('body edited'));
    expect(result.current.state.dirty).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(mocked.save).toHaveBeenCalledWith('a.md', 'body edited', 'h1');
    await waitFor(() => expect(result.current.state.dirty).toBe(false));
  });

  it('sets conflict on 409 and stops autosaving', async () => {
    const { result } = await openNote();
    mocked.save!.mockRejectedValue(
      new ApiError(409, 'conflict', { current: { content: 'disk', mtimeMs: 3, hash: 'hd' } }),
    );
    act(() => result.current.handleChange('mine'));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(result.current.state.conflict?.content).toBe('disk'));
    mocked.save!.mockClear();
    await act(() => result.current.saveNow());
    expect(mocked.save).not.toHaveBeenCalled();
  });

  it('keeps dirty and retries on network error', async () => {
    const { result } = await openNote();
    mocked.save!.mockRejectedValueOnce(new ApiError(0, 'network error'));
    mocked.save!.mockResolvedValueOnce({ mtimeMs: 2, hash: 'h2' });
    act(() => result.current.handleChange('x'));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.state.dirty).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(result.current.state.dirty).toBe(false));
    expect(mocked.save).toHaveBeenCalledTimes(2);
  });

  it('external with same hash is an echo: buffer untouched', async () => {
    const { result } = await openNote('h1', 'body');
    const before = result.current.state.revision;
    mocked.note!.mockResolvedValue(noteResponse('body', 'h1', 'New Title'));
    await act(() => result.current.external('a.md'));
    expect(result.current.state.revision).toBe(before);
    expect(result.current.state.title).toBe('New Title');
  });

  it('external on clean buffer reloads content and bumps revision', async () => {
    const { result } = await openNote('h1', 'body');
    const before = result.current.state.revision;
    mocked.note!.mockResolvedValue(noteResponse('from disk', 'h9'));
    await act(() => result.current.external('a.md'));
    expect(result.current.state.content).toBe('from disk');
    expect(result.current.state.revision).toBe(before + 1);
  });

  it('external on dirty buffer sets conflict', async () => {
    const { result } = await openNote();
    act(() => result.current.handleChange('mine'));
    mocked.note!.mockResolvedValue(noteResponse('theirs', 'h9'));
    await act(() => result.current.external('a.md'));
    expect(result.current.state.conflict?.content).toBe('theirs');
    expect(result.current.state.dirty).toBe(true);
  });

  it('keepTheirs applies disk content; keepMine saves with conflict hash', async () => {
    const { result } = await openNote();
    act(() => result.current.handleChange('mine'));
    mocked.note!.mockResolvedValue(noteResponse('theirs', 'h9'));
    await act(() => result.current.external('a.md'));
    act(() => result.current.keepTheirs());
    expect(result.current.state.content).toBe('theirs');
    expect(result.current.state.conflict).toBeNull();
    expect(result.current.state.dirty).toBe(false);
  });

  it('keepMine overwrites using the conflict hash as base', async () => {
    const { result } = await openNote();
    act(() => result.current.handleChange('mine'));
    mocked.note!.mockResolvedValue(noteResponse('theirs', 'h9'));
    await act(() => result.current.external('a.md'));
    mocked.save!.mockResolvedValue({ mtimeMs: 5, hash: 'h10' });
    await act(() => result.current.keepMine());
    expect(mocked.save).toHaveBeenCalledWith('a.md', 'mine', 'h9');
    expect(result.current.state.conflict).toBeNull();
    expect(result.current.state.dirty).toBe(false);
  });

  it('saveAsCopy creates a unique copy and switches to it', async () => {
    const { result } = await openNote();
    act(() => result.current.handleChange('mine'));
    mocked.note!.mockResolvedValue(noteResponse('theirs', 'h9'));
    await act(() => result.current.external('a.md'));
    mocked.create!.mockResolvedValue({ path: 'a-copy.md', mtimeMs: 6, hash: 'hc' });
    await act(() => result.current.saveAsCopy());
    expect(mocked.create).toHaveBeenCalledWith('a.md', 'mine', true);
    expect(result.current.state.path).toBe('a-copy.md');
    expect(result.current.state.title).toBe('a-copy');
    expect(result.current.state.conflict).toBeNull();
    expect(result.current.state.dirty).toBe(false);
  });

  it('open flushes a pending dirty save first', async () => {
    const { result } = await openNote();
    mocked.save!.mockResolvedValue({ mtimeMs: 2, hash: 'h2' });
    act(() => result.current.handleChange('unsaved'));
    mocked.note!.mockResolvedValue({
      content: 'other', backlinks: [],
      meta: { path: 'b.md', title: 'B', tags: [], links: [], headings: [], mtimeMs: 1, hash: 'hb' },
    });
    await act(() => result.current.open('b.md'));
    expect(mocked.save).toHaveBeenCalledWith('a.md', 'unsaved', 'h1');
    expect(result.current.state.path).toBe('b.md');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project web`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`web/src/hooks/useNoteEditor.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project web` — all 11 hook tests PASS (plus earlier web tests). `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useNoteEditor.ts web/test/useNoteEditor.test.ts
git commit -m "feat(web): note editor state machine with autosave and conflict handling"
```

---

### Task 6: App wiring — tree, editor, note CRUD

**Files:**
- Replace: `web/src/App.tsx`
- Replace test: `web/test/app.test.tsx`

**Interfaces:**
- Consumes: `api` (2), `FileTree` (3), `EditorPane` (4), `useNoteEditor` (5)
- Produces the full App used by Tasks 7–9, with these stable hooks for later tasks (they will edit this file):
  - `refreshTree` callback; `editor` (the `useNoteEditor()` result)
  - topbar contains `data-testid="note-title"` span and `data-testid="save-state"` span (`Saving…` / `Edited` / `Saved` / empty)
  - inline `NameInput` (no `window.prompt`) for create/rename; two-click delete (`Delete` → `Really delete?`), no `window.confirm`
  - `EditorPane` keyed `${path}#${revision}`

- [ ] **Step 1: Replace the smoke test with behavioral tests**

`web/test/app.test.tsx` (replaces the Task-1 file):
```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      tree: vi.fn(), note: vi.fn(), save: vi.fn(), create: vi.fn(),
      remove: vi.fn(), rename: vi.fn(), search: vi.fn(),
    },
  };
});

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const tree = {
  name: '', path: '', type: 'folder' as const,
  children: [{ name: 'a.md', path: 'a.md', type: 'note' as const }],
};

function noteResponse(path: string, content: string) {
  return {
    content, backlinks: [],
    meta: { path, title: path.replace('.md', ''), tags: [], links: [], headings: [], mtimeMs: 1, hash: 'h1' },
  };
}

beforeEach(() => {
  Object.values(mocked).forEach((fn) => fn.mockReset());
  mocked.tree!.mockResolvedValue(tree);
});

describe('App', () => {
  it('loads the tree and opens a note', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', '# A note'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));
    expect(mocked.note).toHaveBeenCalledWith('a.md');
  });

  it('creates a note through the inline input', async () => {
    mocked.create!.mockResolvedValue({ path: 'new.md', mtimeMs: 1, hash: 'h' });
    mocked.note!.mockResolvedValue(noteResponse('new.md', ''));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New' }));
    const input = screen.getByPlaceholderText('path/note.md');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(mocked.create).toHaveBeenCalledWith('new.md'));
    await waitFor(() => expect(mocked.note).toHaveBeenCalledWith('new.md'));
  });

  it('deletes only after the two-click confirm', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', 'x'));
    mocked.remove!.mockResolvedValue({ trashedTo: '.trash/a.md' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mocked.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Really delete?' }));
    await waitFor(() => expect(mocked.remove).toHaveBeenCalledWith('a.md'));
  });

  it('renames via the inline input', async () => {
    mocked.note!.mockResolvedValue(noteResponse('a.md', 'x'));
    mocked.rename!.mockResolvedValue({ rewritten: [] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a' }));
    await waitFor(() => expect(screen.getByTestId('note-title').textContent).toBe('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByPlaceholderText('path/note.md') as HTMLInputElement;
    expect(input.value).toBe('a.md');
    fireEvent.change(input, { target: { value: 'b.md' } });
    mocked.note!.mockResolvedValue(noteResponse('b.md', 'x'));
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(mocked.rename).toHaveBeenCalledWith('a.md', 'b.md'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project web`
Expected: FAIL — placeholder App has none of this.

- [ ] **Step 3: Implement — replace `web/src/App.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { TreeNode } from '@noteviewer/shared';
import { api } from './api';
import { EditorPane } from './components/EditorPane';
import { FileTree } from './components/FileTree';
import { useNoteEditor } from './hooks/useNoteEditor';

type Naming = { mode: 'create' } | { mode: 'rename'; from: string } | null;

export function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [naming, setNaming] = useState<Naming>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const editor = useNoteEditor();
  const { path, title, content, revision, dirty, saving } = editor.state;

  const refreshTree = useCallback(() => {
    api.tree().then(setTree).catch(() => {});
  }, []);

  useEffect(() => refreshTree(), [refreshTree]);
  useEffect(() => setConfirmingDelete(false), [path]);

  const ensureMd = (name: string) => (name.endsWith('.md') ? name : `${name}.md`);

  async function submitName(value: string) {
    const target = ensureMd(value);
    if (naming?.mode === 'create') {
      const res = await api.create(target);
      await editor.open(res.path);
    } else if (naming?.mode === 'rename') {
      await api.rename(naming.from, target);
      await editor.open(target);
    }
    setNaming(null);
    refreshTree();
  }

  async function doDelete() {
    if (!path) return;
    await api.remove(path);
    editor.clear();
    setConfirmingDelete(false);
    refreshTree();
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <button onClick={() => setNaming({ mode: 'create' })}>+ New</button>
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
          <span className="title" data-testid="note-title">{path ? title : 'noteviewer'}</span>
          {path && (
            <>
              <button onClick={() => setNaming({ mode: 'rename', from: path })}>Rename</button>
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
        {path ? (
          <EditorPane
            key={`${path}#${revision}`}
            initialContent={content}
            onChange={editor.handleChange}
            onSave={() => void editor.saveNow()}
          />
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project web` — PASS. Full `npx vitest run` and `npm run typecheck` — clean.

- [ ] **Step 5: Manual sanity check (dev servers)**

Run: `npm run dev` (server, port 8080, VAULT_PATH pointing at a scratch vault — `VAULT_PATH=$(mktemp -d) npm run dev` and drop a note in it) and `npm run dev -w web` in another shell; open http://localhost:5173, verify tree loads and a note opens/edits/saves. Kill both. (Skip if a display isn't available — the e2e task covers this end-to-end.)

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx web/test/app.test.tsx
git commit -m "feat(web): app shell wiring with tree, editor, and note CRUD"
```

---

### Task 7: Conflict bar

**Files:**
- Create: `web/src/components/ConflictBar.tsx`
- Modify: `web/src/App.tsx` (render it)
- Test: `web/test/conflictbar.test.tsx`

**Interfaces:**
- Consumes: `useNoteEditor`'s `conflict` state + `keepTheirs`/`keepMine`/`saveAsCopy` (Task 5)
- Produces: `ConflictBar({ onTheirs, onMine, onCopy })` — renders `role="alert"` bar with EXACTLY three buttons labeled `Load theirs`, `Overwrite with mine`, `Save as copy`

- [ ] **Step 1: Write the failing tests**

`web/test/conflictbar.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConflictBar } from '../src/components/ConflictBar';

describe('ConflictBar', () => {
  it('offers exactly the three resolutions', () => {
    const theirs = vi.fn();
    const mine = vi.fn();
    const copy = vi.fn();
    render(<ConflictBar onTheirs={theirs} onMine={mine} onCopy={copy} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Load theirs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as copy' }));
    expect(theirs).toHaveBeenCalledOnce();
    expect(mine).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project web` — FAIL, module not found.

- [ ] **Step 3: Implement**

`web/src/components/ConflictBar.tsx`:
```tsx
export interface ConflictBarProps {
  onTheirs(): void;
  onMine(): void;
  onCopy(): void;
}

export function ConflictBar({ onTheirs, onMine, onCopy }: ConflictBarProps) {
  return (
    <div className="conflict-bar" role="alert">
      <span>This note changed on disk while you were editing.</span>
      <div className="conflict-actions">
        <button onClick={onTheirs}>Load theirs</button>
        <button onClick={onMine}>Overwrite with mine</button>
        <button className="primary" onClick={onCopy}>Save as copy</button>
      </div>
    </div>
  );
}
```

In `web/src/App.tsx`: add the import
```tsx
import { ConflictBar } from './components/ConflictBar';
```
destructure `conflict` from `editor.state` alongside the others, and insert directly ABOVE the `{path ? (` editor block, inside `<main>` after `</header>`:
```tsx
        {conflict && (
          <ConflictBar
            onTheirs={editor.keepTheirs}
            onMine={() => void editor.keepMine()}
            onCopy={() => void editor.saveAsCopy()}
          />
        )}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project web` — PASS. `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ConflictBar.tsx web/src/App.tsx web/test/conflictbar.test.tsx
git commit -m "feat(web): three-option conflict bar"
```

---

### Task 8: SSE live updates

**Files:**
- Create: `web/src/hooks/useVaultEvents.ts`
- Modify: `web/src/App.tsx` (wire it)
- Test: `web/test/useVaultEvents.test.ts`

**Interfaces:**
- Consumes: shared `VaultEvent` (`import type`); App's `refreshTree` and `editor.external`
- Produces: `useVaultEvents({ onTreeChanged(): void; onNoteChanged(path: string): void })` — opens ONE `EventSource('/api/events')` for the component's lifetime (handlers held in a ref so re-renders don't reconnect), dispatches parsed events, ignores malformed frames, closes on unmount. (Reconnection on drop is the browser's native EventSource behavior — the server already sends `retry: 3000`.)

- [ ] **Step 1: Write the failing tests**

`web/test/useVaultEvents.test.ts`:
```ts
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVaultEvents } from '../src/hooks/useVaultEvents';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe('useVaultEvents', () => {
  it('connects once and dispatches events to the handlers', () => {
    const onTreeChanged = vi.fn();
    const onNoteChanged = vi.fn();
    const hook = renderHook(() => useVaultEvents({ onTreeChanged, onNoteChanged }));
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/api/events');
    es.onmessage!({ data: JSON.stringify({ type: 'tree-changed' }) });
    es.onmessage!({ data: JSON.stringify({ type: 'note-changed', path: 'a.md' }) });
    es.onmessage!({ data: 'not json' });
    expect(onTreeChanged).toHaveBeenCalledOnce();
    expect(onNoteChanged).toHaveBeenCalledWith('a.md');
    hook.rerender();
    expect(FakeEventSource.instances).toHaveLength(1);
    hook.unmount();
    expect(es.closed).toBe(true);
  });

  it('uses the latest handlers after re-render', () => {
    let seen = '';
    const hook = renderHook(
      ({ tag }: { tag: string }) =>
        useVaultEvents({ onTreeChanged: () => { seen = tag; }, onNoteChanged: () => {} }),
      { initialProps: { tag: 'first' } },
    );
    hook.rerender({ tag: 'second' });
    FakeEventSource.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'tree-changed' }) });
    expect(seen).toBe('second');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project web` — FAIL, module not found.

- [ ] **Step 3: Implement**

`web/src/hooks/useVaultEvents.ts`:
```ts
import { useEffect, useRef } from 'react';
import type { VaultEvent } from '@noteviewer/shared';

export interface VaultEventHandlers {
  onTreeChanged(): void;
  onNoteChanged(path: string): void;
}

export function useVaultEvents(handlers: VaultEventHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      let ev: VaultEvent;
      try {
        ev = JSON.parse(e.data) as VaultEvent;
      } catch {
        return;
      }
      if (ev.type === 'tree-changed') ref.current.onTreeChanged();
      else if (ev.type === 'note-changed') ref.current.onNoteChanged(ev.path);
    };
    return () => es.close();
  }, []);
}
```

In `web/src/App.tsx`: add the import
```tsx
import { useVaultEvents } from './hooks/useVaultEvents';
```
and inside `App()`, after `refreshTree` is defined:
```tsx
  useVaultEvents({
    onTreeChanged: refreshTree,
    onNoteChanged: (p) => void editor.external(p),
  });
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project web` — PASS. `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useVaultEvents.ts web/src/App.tsx web/test/useVaultEvents.test.ts
git commit -m "feat(web): SSE live updates wired into tree and editor"
```

---

### Task 9: Offline banner and mobile drawer

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/test/offline.test.tsx`

**Interfaces:**
- Consumes: `onNetworkError` (Task 2)
- Produces: App shows `.offline-banner` ("Vault unreachable — retrying…") whenever a request hits a network error; while offline it pings `api.tree()` every 10 s and clears the banner (and refreshes the tree) on success. A `.hamburger` button (`aria-label="Toggle sidebar"`) toggles `sidebar-open` on the `.app` div (CSS from Task 1 makes it a drawer under 768 px).

- [ ] **Step 1: Write the failing tests**

`web/test/offline.test.tsx`:
```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  let listener: (() => void) | null = null;
  return {
    ...actual,
    onNetworkError: (fn: (() => void) | null) => { listener = fn; },
    fireNetworkError: () => listener?.(),
    api: {
      tree: vi.fn(), note: vi.fn(), save: vi.fn(), create: vi.fn(),
      remove: vi.fn(), rename: vi.fn(), search: vi.fn(),
    },
  };
});

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const emptyTree = { name: '', path: '', type: 'folder' as const, children: [] };

beforeEach(() => {
  Object.values(mocked).forEach((fn) => fn.mockReset());
  mocked.tree!.mockResolvedValue(emptyTree);
});

describe('offline banner', () => {
  it('appears on network error and clears when a retry ping succeeds', async () => {
    vi.useFakeTimers();
    const mod = (await import('../src/api')) as unknown as { fireNetworkError(): void };
    render(<App />);
    act(() => mod.fireNetworkError());
    expect(await screen.findByText(/Vault unreachable/)).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(screen.queryByText(/Vault unreachable/)).toBeNull());
    vi.useRealTimers();
  });
});

describe('mobile drawer', () => {
  it('toggles the sidebar-open class', async () => {
    const { container } = render(<App />);
    const appDiv = container.querySelector('.app')!;
    expect(appDiv.className).not.toContain('sidebar-open');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(appDiv.className).toContain('sidebar-open');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(appDiv.className).not.toContain('sidebar-open');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project web` — FAIL.

- [ ] **Step 3: Implement — edits to `web/src/App.tsx`**

Add `onNetworkError` to the existing `./api` import. Add state and effects inside `App()`:
```tsx
  const [offline, setOffline] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
```
Change the root div to `className={`app${sidebarOpen ? ' sidebar-open' : ''}`}`. Add as the FIRST child of `<header className="topbar">`:
```tsx
          <button className="hamburger" aria-label="Toggle sidebar" onClick={() => setSidebarOpen((o) => !o)}>☰</button>
```
Add directly after `</header>` (before the conflict bar):
```tsx
        {offline && <div className="offline-banner">Vault unreachable — retrying…</div>}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run` (both projects) and `npm run typecheck` — all clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx web/test/offline.test.tsx
git commit -m "feat(web): offline banner with retry ping and mobile drawer"
```

---

### Task 10: Playwright e2e and CI wiring

**Files:**
- Create: `playwright.config.ts`, `e2e/prepare-vault.mjs`, `e2e/app.spec.ts`
- Modify: `package.json` (root: `@playwright/test` devDep, `test:e2e` script), `.github/workflows/docker.yml` (run e2e in the test job)

**Interfaces:**
- Consumes: the whole app, served for real: `web/dist` built by Vite, `server/src/main.ts` run via tsx against a fixture vault at `e2e/.vault` (already gitignored in Task 1)
- Produces: `npm run test:e2e` = build web + run Playwright (chromium); CI runs it after unit tests and typecheck, before the Docker publish

- [ ] **Step 1: Write the config, fixture script, and tests**

Root `package.json`: add to devDependencies
```json
    "@playwright/test": "^1.48.0",
```
and to scripts
```json
    "test:e2e": "npm run build -w web && playwright test",
```

`e2e/prepare-vault.mjs`:
```js
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('e2e/.vault', { recursive: true, force: true });
mkdirSync('e2e/.vault/sub', { recursive: true });
writeFileSync('e2e/.vault/Welcome.md', '# Welcome\n\nHello from the fixture vault. See [[sub/Other]].\n');
writeFileSync('e2e/.vault/sub/Other.md', '# Other\n\nAnother note.\n');
```

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://127.0.0.1:8125' },
  webServer: {
    command: 'node e2e/prepare-vault.mjs && VAULT_PATH=e2e/.vault PORT=8125 npx tsx server/src/main.ts',
    url: 'http://127.0.0.1:8125/api/tree',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
```

`e2e/app.spec.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const VAULT = 'e2e/.vault';

test('tree lists notes and opens content', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Welcome' }).click();
  await expect(page.locator('.cm-content')).toContainText('Hello from the fixture vault');
});

test('typing autosaves to disk', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Welcome' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('Autosaved line. ');
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 5000 });
  expect(readFileSync(`${VAULT}/Welcome.md`, 'utf8')).toContain('Autosaved line.');
});

test('external change reloads a clean editor', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Other' }).click();
  await expect(page.locator('.cm-content')).toContainText('Another note');
  writeFileSync(`${VAULT}/sub/Other.md`, '# Other\n\nChanged externally.\n');
  await expect(page.locator('.cm-content')).toContainText('Changed externally', { timeout: 10_000 });
});

test('dirty editor + external change → conflict bar → save as copy', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Welcome' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.locator('.cm-content').click();
  writeFileSync(`${VAULT}/Welcome.md`, '# Welcome\n\nTheirs version.\n');
  await page.keyboard.type('My concurrent edit. ');
  await expect(page.locator('.conflict-bar')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Save as copy' }).click();
  await expect(page.getByTestId('note-title')).toContainText('Welcome-copy', { timeout: 5000 });
  expect(readFileSync(`${VAULT}/Welcome-copy.md`, 'utf8')).toContain('My concurrent edit.');
});
```

Note on the 4th test's determinism: the external write lands while typing keeps the buffer dirty; whichever signal arrives first — the SSE `note-changed` (→ dirty-buffer conflict) or the autosave's stale-hash `409` — the result is the same conflict bar. Both paths are the product paths being tested.

- [ ] **Step 2: Install and run locally**

Run: `npm install && npx playwright install --with-deps chromium` (the `--with-deps` may prompt for sudo on Arch — if it does, run `npx playwright install chromium` without deps instead; the system libs are typically present).
Then: `npm run test:e2e`
Expected: 4 passed.

- [ ] **Step 3: Wire into CI — edit `.github/workflows/docker.yml`**

In the `test` job, after the `- run: npm run typecheck` step, add:
```yaml
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
```

- [ ] **Step 4: Full local gate**

Run: `npx vitest run && npm run typecheck && npm run test:e2e`
Expected: everything green. Also verify no stray server remains: `pgrep -f 'tsx server/src/main.ts' || echo clean`.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e/prepare-vault.mjs e2e/app.spec.ts package.json package-lock.json .github/workflows/docker.yml
git commit -m "test(web): playwright e2e suite wired into CI"
```

---

## After this plan

- Push to main → CI runs unit + e2e + publishes the image; pull the new `ghcr.io/glitchtit/noteviewer:latest` on Unraid — the container now serves the real app.
- Plan 3 (rich rendering): live-preview decorations, KaTeX, Mermaid, reading mode, kanban board view, search UI + quick switcher, backlinks/outline panel — plus the deferred hardening backlog (SSE `reply.hijack()`, bus max-listeners, SIGTERM shutdown, EISDIR 404, non-root container, workflow action version bumps).
