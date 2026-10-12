# Claude vault agent — design

Date: 2026-10-12 · Status: approved (sections 1–3 in chat; user asked to proceed autonomously)

## Goal

Replace the Gemini note assistant with a Claude-powered **agent** that works on
the whole vault the way Claude Code would if started with `cwd` = the vault:
it reads, searches, creates, edits, moves and deletes notes over many steps,
and can use the web. The user prompts; the agent acts.

### Decisions (from the user)

| Topic | Decision |
|---|---|
| Provider | Claude API via `ANTHROPIC_API_KEY` (server-side only). Gemini removed. |
| Capabilities | Vault operations + web search/fetch. **No shell.** Tools built on the app's own vault layer. |
| Approval | Auto-apply every change; every run gets an undo journal (per-file and "undo all"). |
| Sessions | Saved server-side in `/data`; resumable from a session list; survive note switches and devices. |
| Quick actions | Kept as preset prompts the agent acts on; insert/append/replace buttons removed. |
| Runtime | Server-side runs decoupled from HTTP (survive tab close); UI attaches over SSE. |

Non-goals: shell/Bash, MCP, sub-agents, slash commands defined in the vault,
permission prompts, multi-user.

## Architecture

```
web AiPanel ──POST /runs──▶ RunManager ──▶ agent loop (Anthropic SDK stream)
      ▲                         │                 │  tool_use
      └──SSE /events◀── run event buffer          ▼
                                            VaultTools ──▶ vault/ops.ts ──▶ files.ts / index / bus
                                                 │
                                            ChangeJournal (undo)   SessionStore (/data/ai-sessions)
```

New server modules (`server/src/ai/`):

- `config.ts` — env → `AgentConfig` (`apiKey`, `model`, `effort`, `profileNote`, `maxRounds`, `fallbacks`).
- `prompt.ts` — system prompt (vault conventions carried over from the old
  `skill.ts`, agent behaviour, tool guidance) + vault `CLAUDE.md` + `AI Profile.md`;
  per-turn context block; quick-action preset prompts (exported to `shared`).
- `tools.ts` — tool definitions (JSON schema) + `VaultTools` executor.
- `journal.ts` — change records and undo.
- `sessions.ts` — `SessionStore` (JSON files, atomic writes).
- `agent.ts` — `runAgent()` loop: stream, dispatch tools, emit events, append history.
- `runs.ts` — `RunManager`: one active run per session, event buffer, SSE fan-out, stop, shutdown.

New `server/src/vault/ops.ts` extracts the mutation logic currently inline in
`vault-routes.ts` (create/write with index+bus updates, rename with link
rewriting + share rename, trash with share removal) so routes and agent share
one implementation. Route behaviour is unchanged; existing route tests guard it.

Removed: `server/src/ai/gemini.ts`, `server/src/ai/skill.ts`, `POST /api/ai`,
`GEMINI_*` env, `streamAi` in `web/src/api.ts`, `AiAction`.

## 1. Agent core

### Model call

`client.beta.messages.stream()` from `@anthropic-ai/sdk` with:

- `model`: `AI_MODEL` (default `claude-opus-5-5`); `max_tokens: 64000`.
- `thinking: { type: 'adaptive', display: 'summarized' }` — summaries shown collapsed.
- `output_config: { effort }` — `AI_EFFORT` (default `high`).
- `cache_control: { type: 'ephemeral' }` (top-level auto caching).
- Betas `compact-2026-01-12` + `context_management: { edits: [{ type: 'compact_20260112' }] }`
  (server-side compaction for long sessions).
- Betas `server-side-fallback-2026-07-01` + `fallbacks: 'default'` (refusal
  fallback). Disable with `AI_FALLBACKS=off`.
- `tools`: the custom tools below (each `eager_input_streaming: true`,
  inputs validated before execution) + `{type:'web_search_20260209', name:'web_search', max_uses: 8}`
  + `{type:'web_fetch_20260209', name:'web_fetch', max_uses: 8}`.

**Append-only history** (required for preserved thinking + prompt caching):
the full `response.content` of every assistant turn is appended verbatim;
earlier messages, the system prompt, and the tool list are never edited
within a session. The **system prompt is frozen per session** at creation
(snapshot of conventions + `CLAUDE.md` + profile). Changes to `CLAUDE.md` /
the profile apply to new sessions; the panel says so.

### Loop

Per round: stream → `finalMessage()` →
- `end_turn` / `refusal` / other terminal → append (unless refused before any output) and finish.
- `pause_turn` → append assistant content, re-request.
- `tool_use` with `stop_reason: max_tokens` → finish with error (truncated input; never executed).
- `tool_use` → append assistant content; execute each custom tool **sequentially**
  (writes must not race); return all `tool_result`s in one user message.
- Tool input that fails validation → `is_error` result naming the problem.
- JSON parse failure of a streamed tool input → re-issue the round, max 2 consecutive.
- Cap: `AI_MAX_ROUNDS` (default 60) → finish with a "round limit reached" notice.

**Stop/abort**: abort signal cancels the stream. A partially streamed assistant
turn is discarded (not appended). If abort lands between appending a
`tool_use` turn and its results, the remaining calls get
`is_error: "Interrupted by the user"` results so the history stays valid.
API errors (`Anthropic.APIError` chain: auth 401 → "invalid API key", 429 →
"rate limited", others → message) end the run with an `error` event; history
is left valid (the failed turn is not appended).

### Tools

All paths are vault-relative, POSIX, resolved with `resolveVaultPath`; any
segment that is hidden (`isHiddenName`) is rejected — so `.obsidian`,
`.trash`, `.git` are unreachable. Errors return `is_error: true` with a short
message the model can act on.

| Tool | Input | Behaviour |
|---|---|---|
| `list` | `path?` (folder, default root), `depth?` (default 2) | Indented tree of folders/files from `buildTree`. |
| `read` | `path`, `offset?`, `limit?` (lines; default 2000) | `.md`/text: content with line numbers (`cat -n` style), records the file's hash as "seen". Images (png/jpg/gif/webp) → image block; PDF → document block (≤ 20 MB). |
| `search` | `query`, `limit?` (default 20) | MiniSearch index: path, title, score. |
| `grep` | `pattern` (JS regex), `path?` (folder), `glob?` (e.g. `*.md`), `ignore_case?`, `limit?` (default 200 matches) | Line matches `path:line: text`. |
| `links` | `path` | Outgoing links (resolved / unresolved), backlinks, tags, headings from the index. |
| `write` | `path` (`.md`), `content` | Create, or overwrite an existing note (requires it was read this session and is unchanged). |
| `edit` | `path`, `old_string`, `new_string`, `replace_all?` | Exact replacement. `old_string` must occur exactly once unless `replace_all`. Requires read + unchanged. |
| `move` | `from`, `to` (both `.md`) | Rename/move with backlink rewriting (`vault/ops.ts`). Fails if target exists. |
| `delete` | `path` (`.md`) | Moves to `.trash` (existing `trashNote`). |

**Read-before-write**: the session keeps `seen: Record<path, hash>` (persisted
with the session). `write` on an existing file and `edit` require
`seen[path] === currentHash`; otherwise the tool errors with "File has changed
since you last read it (or was never read). Read it again before editing." A
successful write updates `seen[path]` to the new hash, so successive edits work.
`write` to a new path needs no read.

Writes go through `vault/ops.ts`, which updates the index and emits bus events,
so the tree, backlinks and open editors update live. The agent's own write
also arrives via the chokidar watcher; that is harmless (index update is
idempotent; the editor's hash echo-suppression treats a matching hash as
already-known).

Tool result summaries for the UI are produced by the executor
(`{ summary: string, detail?: string, change?: ChangeRecord }`), e.g.
`Edited Projects/Foo.md (+4 −1)` with a unified diff as `detail`.

### Prompt

System prompt = agent role + tool guidance + vault conventions (from old
`skill.ts`: wikilinks only to existing notes, tags reuse, tasks, callouts,
math, mermaid, frontmatter preserved byte-for-byte, kanban structure) +
behaviour (same language as the user/note, never invent facts, cite notes as
`[[wikilinks]]`, concise, prefer `edit` over `write` for existing notes, read
before editing; act directly rather than asking for confirmation — every
change is undoable — and end with a short summary of what changed) + `<vault_claude_md>` + `<user_profile>`
when present.

Each user turn = the prompt text plus a context block:
`<context>Open note: Projects/Foo.md\nSelected text:\n…</context>` (only the
parts that exist). Note content is not inlined; the agent reads it.

Quick-action presets (in `shared`) — sent as normal prompts:
- **Summarize** — "Summarise the open note (or the selection). Reply in chat; don't edit files."
- **Tidy up** — "Tidy up the open note (or the selected part): fix language, add structure, convert obvious to-dos to tasks. Keep all information, links, tags, frontmatter and the author's voice. Edit the file."
- **Action items** — "Extract every action item from the open note as a task list and append it under an '## Action items' heading (skip ones already present). Edit the file."
- **Tags & links** — "Find related notes in the vault and add fitting existing #tags and [[links]] to the open note. Edit the file and tell me what you added."
- **Continue** — "Continue writing the open note from where it ends, in the same style. Append to the file."

## 2. Runs, sessions, undo, transport

### Session file — `/data/ai-sessions/<id>.json`

```ts
interface StoredSession {
  id: string;                 // random base64url
  title: string;              // first prompt, trimmed to 80 chars
  createdAt: string; updatedAt: string;
  model: string;
  system: string;             // frozen system prompt
  messages: BetaMessageParam[];   // full API history, append-only
  seen: Record<string, string>;   // read-before-write hashes
  turns: Turn[];              // UI transcript (see below)
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}
interface Turn {             // one user prompt + the run it started
  id: string; prompt: string; context: { path?: string; selection?: string };
  items: TurnItem[];         // text / thinking / tool rows in order
  changes: ChangeRecord[];   // undo journal for this run
  status: 'running' | 'done' | 'stopped' | 'error';
  error?: string; usage?: Usage; startedAt: string; endedAt?: string;
}
```

`turns` is a UI-oriented transcript (built from the same events streamed
live) so the panel can render a resumed session without parsing API
history. Writes are atomic (`tmp` + rename). Sessions are listed by
`updatedAt` desc. An index is not needed at personal scale; listing reads
headers by parsing each file (cached in memory after first load).

### HTTP API (private app only)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/ai/status` | `{enabled, model, profileNote, profileExists, claudeMdExists}` |
| GET | `/api/ai/sessions` | `[{id,title,updatedAt,running}]` |
| POST | `/api/ai/sessions` | create → `{id}` (snapshots system prompt) |
| GET | `/api/ai/sessions/:id` | `{id,title,turns,usage,running}` (no raw API history) |
| DELETE | `/api/ai/sessions/:id` | 409 while running |
| POST | `/api/ai/sessions/:id/runs` | `{prompt, path?, selection?}` → 202 `{turnId}`; 409 if a run is active; 503 if no key |
| POST | `/api/ai/sessions/:id/stop` | aborts the active run |
| GET | `/api/ai/sessions/:id/events` | SSE: replays the active turn's events, then live; `: ping` every 25 s |
| POST | `/api/ai/sessions/:id/turns/:turnId/undo` | `{changeIds?: string[], resolution?: 'copy'|'overwrite'|'skip'}` |

SSE event types (`AgentEvent` in `shared`):
`turn_start`, `text_delta {itemId,text}`, `thinking_delta {itemId,text}`,
`tool_start {itemId,name,input}`, `tool_end {itemId,summary,detail?,isError}`,
`server_tool {itemId,name,query?|url?}` (web search/fetch), `change {record}`,
`usage {usage}`, `turn_end {status,error?}`.

### Undo journal

```ts
interface ChangeRecord {
  id: string;
  op: 'create' | 'write' | 'edit' | 'move' | 'delete';
  path: string;               // path after the op (for move: `to`)
  from?: string;              // move source
  before: string | null;      // content before (null for create)
  afterHash: string | null;   // hash after (null for delete)
  trashedTo?: string;         // delete
  rewritten?: string[];       // move: notes whose links were rewritten
  undone?: boolean;
  added: number; removed: number;   // line counts for the UI
}
```

Undo plays records **newest first**:
- create → trash the file (if `afterHash` matches).
- write/edit → restore `before` (if current hash = `afterHash`).
- move → move back `to → from` via `ops.rename` (which rewrites links back).
- delete → recreate `path` with `before` (or `-copy` path if occupied).

**Conflict**: if the current hash ≠ `afterHash` (someone edited it since),
the undo for that record is not applied unless the request carries a
`resolution`: `copy` writes `before` to `uniqueCopyPath(path)` (non-destructive
default offered first), `overwrite` restores anyway, `skip` marks it skipped.
Response: `{ results: [{id, status: 'undone'|'conflict'|'skipped'|'copied', copyPath?}] }`.
Undo is rejected (409) while a run is active on the session.

### RunManager

- `start(sessionId, input)` → creates a `Turn`, persists, launches
  `runAgent` without awaiting; holds `{abort, events[], listeners}`.
- Every event is appended to the turn's `events` buffer and fanned out;
  `TurnItem`s/changes/usage are folded into the session and persisted
  (debounced 500 ms; always on `turn_end`).
- `subscribe(sessionId, fn)` replays buffered events of the active turn.
- `stop(sessionId)`; `shutdown()` aborts all, awaits persistence (wired to
  `app.addHook('onClose')`).
- On server start, any stored turn with `status: 'running'` is marked
  `stopped` (process died mid-run). Its history is repaired if needed:
  a trailing assistant `tool_use` turn without results gets interrupted
  `tool_result`s appended.

### Isolation

AI routes are registered only in `buildApp` (private, port 8080).
`buildPublicApp` (8081) never registers them. A test asserts
`/api/ai/status` is 404 on the public app.

## 3. Panel UI — `web/src/components/AiPanel.tsx` (rewrite)

- **Header**: session dropdown (current title; recent sessions; "New
  session"), model name, Profile button (`AI Profile.md`, created from
  `PROFILE_TEMPLATE` if missing), close.
- **Log**: user bubbles with a context chip (`📄 Foo.md · selection`);
  assistant text rendered with `renderMarkdown`; `[[wikilinks]]` in output
  are clickable (resolve via existing `resolveLink`, open the note);
  thinking as a collapsed muted row; tool rows (`🔍 search "x"`,
  `📖 read Foo.md`, `✏️ Edited Foo.md +4 −1`, `🌐 web_search "x"`) expandable
  to show detail/diff; errors as `role="alert"` rows.
- **Change card** at the end of a turn with changes: list of files with ±
  counts, "Diff" toggle, per-file **Undo**, **Undo all**. Conflicts render
  inline with **Restore as copy** · Overwrite · Skip.
- **Composer**: quick-action chips (disabled without an open note), textarea
  (Enter sends, Shift+Enter newline), Send / Stop.
- Per-turn muted usage line: `12.3k in · 1.2k out · ~$0.07` (price table
  in `shared` for known models; omitted for unknown models).
- Before sending: `await editor.saveNow()`; then POST run; SSE subscription
  per open session (`EventSource`), reconnects automatically; on reconnect
  the session is refetched and the buffer replay fills the active turn.
- Disabled state: "Set `ANTHROPIC_API_KEY` on the server to enable the agent."
- Session id of the last used session is kept in `localStorage` so the panel
  reopens it.

App.tsx: drop `applyAi`/`ApplyMode`; pass `path`, `getSelection`,
`saveNow`, `onOpenNote`, `onOpenProfile`, `onClose`.

## 4. Config, deployment, testing

Env: `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT`, `AI_MAX_ROUNDS`,
`AI_FALLBACKS` (`default`|`off`), `AI_PROFILE_NOTE`. `docker-compose.yml`
and the Unraid notes updated; `GEMINI_*` removed.

`@anthropic-ai/sdk` added to `server` dependencies (pure JS; no image change).

Tests (vitest, no network — the Anthropic client is injected):

- `ops.test.ts` — extracted ops (rename with rewriting, trash, create) keep route behaviour; existing route tests stay green.
- `tools.test.ts` — path confinement (`..`, absolute, hidden segments), list/read (line numbers, ranges, image block), search, grep, links, write/edit read-before-write, edit uniqueness/replace_all, move, delete, change records.
- `journal.test.ts` — undo for each op, newest-first, conflict → copy/overwrite/skip.
- `sessions.test.ts` — create/list/load/delete, atomic persistence, crash repair.
- `agent.test.ts` — fake client streaming scripted messages: tool round-trip, parallel tool_use results in one user message, pause_turn, max_tokens with tool_use, refusal, abort mid-tool (interrupted results), round cap, history append-only.
- `ai-routes.test.ts` — status, session CRUD, run → SSE events → done, 409 on concurrent run, stop, undo endpoint, public app has no AI routes.
- `web/test/aipanel.test.tsx` — rewritten: renders turns, sends runs (calls saveNow first), quick actions, tool rows, change card undo + conflict options, disabled state.
- `web/test/api.test.ts` — new client functions.
