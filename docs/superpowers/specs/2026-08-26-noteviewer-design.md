# Noteviewer — Obsidian Vault Web Viewer/Editor

**Date:** 2026-08-26
**Status:** Approved

## Purpose

A self-hosted web app to view and edit the user's Obsidian vault from any
browser, replacing VNC-based workarounds. Runs as a Docker container on the
Unraid server that hosts the vault; external access goes through Cloudflare
Zero Trust. Goal: "essentially a fully functional Obsidian vault clone" in
the browser.

## Context

- The vault lives at `/mnt/user/appdata/obsidian/Obsidian Vault` on Unraid
  (~155 markdown notes and growing). It is a git repo synced to
  `github.com/Glitchtit/notes` by an existing Unraid-side script.
- Desktop Obsidian clients edit the same folder over the network.
- Obsidian plugins in use that inform rendering requirements: obsidian-git,
  obsidian-kanban, latex-suite (math), omnisearch (search expectations),
  text-extractor, obsidian-importer.
- The app performs **no authentication**; Cloudflare Access is the sole auth
  layer. The app may log `Cf-Access-Authenticated-User-Email` for edit
  attribution.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Editor | CodeMirror 6 live preview (Obsidian-style inline rendering) |
| V1 features | Wikilinks + backlinks, full-text search, KaTeX math, kanban boards, Mermaid diagrams |
| Persistence | Write .md files directly to the mounted vault; existing script keeps owning git sync |
| Stack | TypeScript full-stack: Fastify backend + React/Vite frontend |
| Mobile | Desktop-first; mobile collapses to a usable layout (drawer file tree, full-width editor) |
| Theme | **Dark mode only.** No light theme, no toggle, no `prefers-color-scheme` handling |
| Deployment | GitHub repo + GitHub Actions → public image on `ghcr.io/glitchtit/noteviewer`; Unraid pulls from GHCR (same pattern as the user's ReadMeABook fork) |

## Architecture

One Docker container, one Node 22+ runtime. Fastify serves the REST/SSE API
under `/api/*` and the static React build for all other routes. No database:
the vault folder is the data store; all indexes are in-memory and rebuilt on
startup (sub-second at current vault size, fine into the thousands of notes).

```
Browser ── Cloudflare Zero Trust ──> Unraid: noteviewer container
                                        ├─ Fastify API  ─── reads/writes ──> /vault (bind mount)
                                        ├─ SSE stream
                                        ├─ In-memory index (links, tags, search)
                                        └─ chokidar watcher on /vault
```

### Repo layout

```
noteviewer/
├─ server/        Fastify app: routes, vault indexer, watcher, SSE
├─ web/           Vite + React app: editor, views
├─ shared/        TS types shared by both (NoteMeta, VaultEvent, ...)
├─ .github/workflows/docker.yml   CI: test → build → push to GHCR
├─ Dockerfile     multi-stage: build web+server → slim runtime image
└─ docker-compose.yml             local-dev convenience only
```

### API surface

All JSON unless noted.

- `GET /api/tree` — full folder/file tree (markdown + attachments)
- `GET /api/note/*path` — raw markdown + metadata (links, backlinks, tags,
  mtime, content hash)
- `PUT /api/note/*path` — save; carries the base content hash for the
  conflict guard (see Concurrency)
- `POST /api/note` — create
- `DELETE /api/note/*path` — move to the vault's `.trash/` (never unlink)
- `POST /api/rename` — rename/move; rewrites wikilinks in other notes that
  point at the renamed note (Obsidian behavior)
- `GET /api/search?q=` — full-text + filename results (MiniSearch,
  server-side)
- `GET /api/file/*path` — attachments (images, PDFs) streamed with correct
  MIME type
- `GET /api/events` — SSE: `note-changed`, `tree-changed` events from the
  watcher

### Indexer

Parses every note on startup and incrementally on watcher events. Produces:
outgoing wikilinks per note, backlinks (inverted), tags, headings (for
outline), and the full-text search index. The watcher ignores `.obsidian/`,
`.git/`, `.trash/`, and `.venv/`.

## Frontend

### Layout

Classic three-zone Obsidian shell, desktop-first:

- **Left sidebar** (collapsible; off-canvas drawer on mobile): file tree +
  search box. Ctrl+P quick-switcher and Ctrl+Shift+F global search as
  overlays.
- **Center**: one note at a time. No tabs or split panes in v1 (explicit
  YAGNI cut; architecture must not preclude adding them).
- **Right panel** (toggleable): backlinks for the current note + outline
  (headings).

### Editor (live preview)

CodeMirror 6 + `@codemirror/lang-markdown` with a custom decoration layer:
syntax tokens (`**`, `#`, `[[ ]]`) hide unless the cursor is inside them.
Rendered inline: bold/italic/headings, clickable checkboxes, clickable
wikilinks with autocomplete on `[[` (fed from the index), tags, inline
`$math$` via KaTeX, images, callout blocks. Block-level widgets for
`$$math$$`, Mermaid diagrams, and syntax-highlighted code blocks.
Decorations recompute from the Lezer syntax tree on selection change
(the SilverBullet/Obsidian pattern).

### Reading mode

Ctrl+E toggles a fully rendered view: unified/remark/rehype with plugins for
wikilinks, KaTeX, Mermaid, callouts, footnotes, and frontmatter display.
Shares the remark plugin set with the editor's widget rendering; serves as
the fallback renderer for anything live preview doesn't handle inline.

### Kanban

Notes with `kanban-plugin: board` frontmatter open in a board view: columns
from `## headings`, cards from list items, drag-and-drop between columns
writes back markdown in obsidian-kanban's format. Toggle to raw markdown
editing.

### Saving

Autosave debounced ~1 s after typing stops, plus on blur/navigation.
Saved/dirty indicator. Ctrl+S forces immediate save.

### Theme

Dark only, closely following Obsidian's default dark palette.

## Concurrency & conflict handling

Three writers touch the vault: this app, desktop Obsidian, and the git sync
script.

- Every `GET /api/note` response carries mtime + content hash. `PUT` sends
  the hash back; if the disk content changed since, the server rejects with
  `409` plus the current disk content.
- On 409 the client shows a conflict bar with **three** options:
  1. **Load theirs** — discard the local buffer, show the disk version.
  2. **Overwrite with mine** — local buffer wins (disk version remains in
     git history via the sync script).
  3. **Save as copy** — write the buffer to `Note-copy.md` (increment to
     `Note-copy-2.md`, etc. if taken), switch the editor to the copy, leave
     the original untouched. Nothing is lost; merge by hand later.
     "Save as copy" is also the universal fallback when a save fails for
     any other reason.
- The chokidar watcher pushes `note-changed` over SSE; if the open note is
  clean it silently reloads, if dirty the conflict bar appears proactively
  (usually before any 409).
- Writes are atomic: temp file in the same directory, then rename over the
  target — the sync script and Obsidian never observe half-written files.

## Error handling

The vault path is local disk from the container's perspective on Unraid, but
must still tolerate stalls. All file ops get timeouts and surface as clear
API errors. The frontend shows a persistent "vault unreachable" banner when
API calls fail; unsaved edits stay in the browser buffer with an honest
dirty indicator — no client-side write queue. Deletes always go to
`.trash/`.

## Testing

- **Server** (Vitest, fixture vault in a temp dir): indexer (links,
  backlinks, tags, rename-rewrites-links), conflict guard, atomic writes.
- **Markdown pipeline**: snapshot tests — fixture notes with
  wikilinks/math/callouts/kanban in, expected HTML out.
- **Editor** (Playwright smoke): open note, type, autosave, wikilink
  autocomplete, conflict bar on external change.
- CI runs the full suite in the GitHub Actions workflow before the image is
  published.

## Out of scope for v1

- Tabs / split panes (architecture must allow later addition)
- Graph view
- Merge/diff UI for conflicts (superseded by "save as copy")
- Any authentication inside the app
- Light theme
- Obsidian plugin API compatibility
