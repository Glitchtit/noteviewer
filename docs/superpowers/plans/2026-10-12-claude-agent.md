# Claude Vault Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Gemini assistant with a Claude agent that reads, searches, edits, moves and deletes vault notes (plus web search/fetch) in resumable server-side runs with an undo journal.

**Architecture:** A server-side agent loop (`@anthropic-ai/sdk` beta streaming, custom vault tools + Anthropic web tools) runs as a background job per session; a `RunManager` folds events into a persisted session and fans them out over SSE (snapshot first, then live). All vault mutations go through a new `vault/ops.ts` shared with the HTTP routes. The web `AiPanel` is rewritten around sessions, tool rows and an undo card.

**Tech Stack:** TypeScript, Fastify 5, `@anthropic-ai/sdk` 0.133, React 18, vitest, jsdom.

**Spec:** `docs/superpowers/specs/2026-10-12-claude-agent-design.md`

## Global Constraints

- Default model `claude-opus-5-5`; `max_tokens: 64000`; `thinking: {type:'adaptive', display:'summarized'}`; `output_config.effort` from `AI_EFFORT` (default `high`).
- Betas: `compact-2026-01-12` (+ `context_management.edits: [{type:'compact_20260112'}]`) and `server-side-fallback-2026-07-01` (+ `fallbacks: 'default'`, disabled by `AI_FALLBACKS=off`).
- Web tools: `web_search_20260209` / `web_fetch_20260209`, `max_uses: 8` each.
- History is append-only; system prompt frozen per session; tools array constant.
- No shell. Hidden path segments (`isHiddenName`) unreachable. Paths vault-relative POSIX.
- AI routes only on the private app; never on `buildPublicApp`.
- Dark-only UI; conflicts always offer a non-destructive option ("Restore as copy").
- No AI co-author trailers in commits.

## Review Focus

1. User has unsaved edits in the open note when the agent edits it → panel calls `saveNow()` before running; agent edit of a file changed since its read fails (Task 3 test "edit fails after external change").
2. Tab closed / reloaded mid-run → run continues; new SSE subscriber first receives a `snapshot` containing text streamed so far (Task 6 test "late subscriber gets snapshot").
3. Server killed mid-run → on startup the turn is `stopped` and a dangling `tool_use` gets interrupted `tool_result`s (Task 5 test "repairs dangling tool_use").
4. Paths with spaces / ÅÄÖ / nested folders (`Möten/Vecka 1.md`) work for read/edit/move/delete (Task 3 test "unicode paths").
5. Undo after the user edited the file → `conflict`, nothing overwritten; `resolution:'copy'` writes `-copy` (Task 4 tests).

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/src/agent.ts` (new, re-exported from `shared/src/index.ts`) | Wire types (`AiStatus`, `AiTurn`, `TurnItem`, `ChangeRecord`, `AgentEvent`, `AiSession*`, `UndoResult`, `AiUsage`), `foldEvent`, `QUICK_PROMPTS`, `estimateCost` |
| `server/src/vault/ops.ts` (new) | `VaultCtx`, `writeNote`, `createNote`, `deleteNote`, `renameNote` (index + bus + shares side effects) |
| `server/src/routes/vault-routes.ts` | Use `ops.ts` (behaviour unchanged) |
| `server/src/ai/prompt.ts` (new) | `buildSystemPrompt`, `buildUserText` |
| `server/src/ai/tools.ts` (new) | `TOOL_DEFS`, `VaultTools` |
| `server/src/ai/journal.ts` (new) | `undoChanges` |
| `server/src/ai/sessions.ts` (new) | `StoredSession`, `SessionStore` |
| `server/src/ai/agent.ts` (new) | `runAgent`, `AgentClient`, `AgentConfig` |
| `server/src/ai/runs.ts` (new) | `RunManager` |
| `server/src/routes/ai-routes.ts` | Rewritten endpoints |
| `server/src/app.ts`, `server/src/main.ts` | Wiring, env |
| delete `server/src/ai/gemini.ts`, `server/src/ai/skill.ts`, `server/test/ai.test.ts` | Gemini removal |
| `web/src/api.ts` | Session/run/undo client fns; drop `streamAi` |
| `web/src/components/AiPanel.tsx`, `web/src/components/ai/*.tsx` | Panel UI |
| `web/src/App.tsx`, `web/src/theme.css` | Wiring, styles |
| `docker-compose.yml` | Env |

---

### Task 1: Shared agent types + event folding

**Files:** Create `shared/src/agent.ts`; Modify `shared/src/index.ts` (replace `AiStatus`, `AiAction`; `export * from './agent.js'`); Test `server/test/fold.test.ts`.

**Interfaces — Produces:**
```ts
export interface AiStatus { enabled: boolean; model: string; profileNote: string; profileExists: boolean; claudeMdExists: boolean }
export interface AiUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export type TurnItem =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; name: string; input: unknown; done: boolean; summary?: string; detail?: string; isError?: boolean };
export type ChangeOp = 'create' | 'write' | 'edit' | 'move' | 'delete';
export interface ChangeRecord { id: string; op: ChangeOp; path: string; from?: string; before: string | null; afterHash: string | null; trashedTo?: string; rewritten?: string[]; undone?: boolean; added: number; removed: number }
export type TurnStatus = 'running' | 'done' | 'stopped' | 'error';
export interface AiTurn { id: string; prompt: string; context: { path?: string; selection?: string }; items: TurnItem[]; changes: ChangeRecord[]; status: TurnStatus; error?: string; usage?: AiUsage; startedAt: string; endedAt?: string }
export interface AiSessionSummary { id: string; title: string; updatedAt: string; running: boolean }
export interface AiSession extends AiSessionSummary { createdAt: string; model: string; turns: AiTurn[]; usage: AiUsage }
export type AgentEvent =
  | { type: 'snapshot'; session: AiSession }
  | { type: 'turn_start'; turn: AiTurn }
  | { type: 'text_delta'; turnId: string; itemId: string; text: string }
  | { type: 'thinking_delta'; turnId: string; itemId: string; text: string }
  | { type: 'tool_start'; turnId: string; itemId: string; name: string; input: unknown }
  | { type: 'tool_end'; turnId: string; itemId: string; summary: string; detail?: string; isError: boolean }
  | { type: 'change'; turnId: string; record: ChangeRecord }
  | { type: 'usage'; turnId: string; usage: AiUsage }
  | { type: 'turn_end'; turnId: string; status: TurnStatus; error?: string };
export interface UndoResult { id: string; status: 'undone' | 'conflict' | 'skipped' | 'copied' | 'failed'; copyPath?: string; message?: string }
export const ZERO_USAGE: AiUsage;
export function addUsage(a: AiUsage, b: AiUsage): AiUsage;
/** Pure: returns new turns array with the event applied (snapshot/turn_start handled by caller for snapshot; turn_start appends). */
export function foldEvent(turns: AiTurn[], e: AgentEvent): AiTurn[];
export const QUICK_PROMPTS: { id: 'summarize'|'tidy'|'tasks'|'links'|'continue'; label: string; title: string; prompt: string }[];
export function estimateCost(model: string, u: AiUsage): number | undefined; // $/MTok table: opus-5-5 4/20 (cache read 0.20, write 5), sonnet-5-5 2/10 (0.20/2.5), haiku-5-5 0.1/0.5 (0.01/0.125), fable-5-1 10/50 (0.25/12.5)
```

- [ ] Step 1: Tests in `fold.test.ts`: turn_start appends; text_delta creates a text item on first delta and appends on subsequent with same itemId; thinking_delta likewise; tool_start adds tool item `done:false`; tool_end sets summary/detail/isError/done; change pushes record; usage sets turn.usage; turn_end sets status/error/endedAt; events for unknown turnId are ignored; `estimateCost('claude-opus-5-5', {inputTokens:1e6,...0})===4`, unknown model → `undefined`.
- [ ] Step 2: Run `npx vitest run server/test/fold.test.ts` → FAIL (module missing).
- [ ] Step 3: Implement `shared/src/agent.ts`; QUICK_PROMPTS texts verbatim from spec §Prompt.
- [ ] Step 4: Run → PASS. `npm run typecheck` will fail on web/server Gemini references — acceptable until Tasks 7/9; keep `AiAction` export temporarily? No: remove it and fix in later tasks; typecheck only required green at Task 9.
- [ ] Step 5: Commit `feat(shared): agent wire types and event folding`.

### Task 2: Extract vault mutations into `vault/ops.ts`

**Files:** Create `server/src/vault/ops.ts`; Modify `server/src/routes/vault-routes.ts`; Test `server/test/ops.test.ts` (+ existing `routes-mutations.test.ts`, `rename.test.ts` must stay green).

**Interfaces — Produces:**
```ts
export interface VaultCtx { vaultRoot: string; index: VaultIndex; bus: VaultBus; shares: ShareStore }
export async function writeNote(ctx: VaultCtx, rel: string, content: string, baseHash?: string): Promise<WriteResult>; // creates dirs; updates index; emits tree-changed if file was new, then note-changed
export async function createNote(ctx: VaultCtx, rel: string, content: string, unique: boolean): Promise<{ path: string; mtimeMs: number; hash: string } | null>; // null = exists && !unique
export async function deleteNote(ctx: VaultCtx, rel: string): Promise<string>; // trashedTo; index.remove, shares.removePath, tree-changed
export async function renameNote(ctx: VaultCtx, from: string, to: string): Promise<{ rewritten: string[] } | null>; // null = target exists; moves, rewrites backlinks (retry once on conflict), index, shares.renamePath, events
export async function exists(ctx: VaultCtx, rel: string): Promise<boolean>;
```
`FastifyInstance` satisfies `VaultCtx` (decorated). Move the rename body (including `applyRewrites` retry loop) verbatim.

- [ ] Step 1: `ops.test.ts` using `makeVault` + `new VaultIndex(root)`/`init`, `new VaultBus()`, `await ShareStore.open()`: writeNote on new file emits `tree-changed` + `note-changed` and index has it; writeNote with stale baseHash returns conflict and writes nothing; renameNote rewrites `[[a]]` in a referrer and returns it in `rewritten`, returns null when target exists; deleteNote moves to `.trash/` and removes from index; createNote unique → `a-copy.md`.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement; refactor routes to call ops (PUT → `writeNote`, POST → `createNote`, DELETE → `deleteNote`, rename → `renameNote`), keeping status codes.
- [ ] Step 4: `npx vitest run --project server` → all PASS.
- [ ] Step 5: Commit `refactor(server): share vault mutations between routes and agent`.

### Task 3: Vault tools

**Files:** Create `server/src/ai/tools.ts`; Test `server/test/tools.test.ts`.

**Interfaces — Consumes:** `VaultCtx`, ops (Task 2), `ChangeRecord` (Task 1). **Produces:**
```ts
export const TOOL_DEFS: Anthropic.Beta.BetaTool[]; // list, read, search, grep, links, write, edit, move, delete — each eager_input_streaming: true, strict-style schemas with additionalProperties:false
export interface ToolOutcome { content: string | Anthropic.Beta.BetaToolResultBlockParam['content']; isError: boolean; summary: string; detail?: string; change?: Omit<ChangeRecord, 'id'> }
export class VaultTools {
  constructor(ctx: VaultCtx, seen: Record<string, string>); // seen mutated in place
  run(name: string, input: unknown): Promise<ToolOutcome>; // never throws; unknown tool/invalid input → isError
}
export function lineDiff(before: string, after: string): { added: number; removed: number; diff: string }; // unified-ish diff, context 2, capped 400 lines
```
Behaviour per spec §Tools. Validation: hand-rolled per tool (`requireString(input,'path')` etc.) returning `isError` "Invalid input: …". Path check: reject `\0`, absolute, any hidden segment, escape (`resolveVaultPath` throws `PathError`). `read`: text exts `.md .txt .json .canvas .csv .yaml .yml .base .tsv`; images `.png .jpg .jpeg .gif .webp` → `[{type:'image', source:{type:'base64', media_type, data}}]`; `.pdf` → `[{type:'document', source:{type:'base64', media_type:'application/pdf', data}}]`; >20 MB → error. Text output `cat -n` format (`String(n).padStart(6)+'\t'+line`), 2000-line default, lines >2000 chars truncated, footer `… (N more lines; use offset)`. Records `seen[path]=hash` for `.md` reads (full or partial). `grep`: walk via `index.allNotes()` paths for `.md` (filter by folder prefix and simple glob `*`/`**`→regex), regex compile errors → isError. `edit`: count occurrences; 0 → "old_string not found"; >1 without replace_all → "old_string occurs N times; add context or set replace_all"; `old_string === new_string` → error. Summaries: `Listed X`, `Read X (N lines)`, `Searched "q" (N hits)`, `Grep /p/ (N matches)`, `Links of X`, `Created X (+N)`, `Wrote X (+a −r)`, `Edited X (+a −r)`, `Moved A → B (rewrote N links)`, `Deleted X`.

- [ ] Step 1: tests: path escapes (`../x.md`, `/etc/passwd`, `.obsidian/a.md`, `.trash/a.md`) → isError; list depth; read line numbers + offset/limit + records seen; read png → image block; search hits; grep with folder filter + ignore_case + invalid regex; links shows backlinks; write new file (no read needed) → change op `create`, before null; write existing without read → error; edit after read → applied, change op `edit` with before; **edit fails after external change** (read, then `writeNote` via ctx, then edit → error mentioning "changed"); edit non-unique → error, replace_all → ok; consecutive edits after one read succeed; move rewrites backlinks, change has `from` + `rewritten`; delete → `.trash`, change has `trashedTo` + before; **unicode paths** `Möten/Vecka 1.md` read/edit/move/delete.
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: run → PASS.
- [ ] Step 5: Commit `feat(server): vault tools for the Claude agent`.

### Task 4: Undo journal

**Files:** Create `server/src/ai/journal.ts`; Test `server/test/journal.test.ts`.

**Interfaces — Consumes:** ops, `ChangeRecord`, `UndoResult`, `uniqueCopyPath`, `hashContent`. **Produces:**
```ts
export type UndoResolution = 'copy' | 'overwrite' | 'skip';
/** Undo (newest first) the records whose id is in ids (all non-undone when ids undefined). Mutates record.undone. */
export async function undoChanges(ctx: VaultCtx, records: ChangeRecord[], ids?: string[], resolution?: UndoResolution): Promise<UndoResult[]>;
```
Rules per spec §Undo journal. Current hash read via `readNote` (missing file → current = null). Conflict = current hash ≠ `afterHash` (for delete: target path now exists → treat as conflict unless resolution). `copy` writes `before` to `uniqueCopyPath(path)` (for create: copy meaningless → 'skipped'). Move undo: if `from` occupied → conflict; else `renameNote(to→from)`.

- [ ] Step 1: tests: undo edit restores content; undo create trashes; undo delete recreates with content; undo move moves back and restores referrer link; newest-first (edit then edit same file → undo all restores original); **conflict**: edit by agent, then user write → result `conflict`, file untouched; resolution `copy` → `copied` with `copyPath` `x-copy.md` containing before, original untouched; `overwrite` → restored; `skip` → skipped; already-undone records ignored.
- [ ] Step 2–4: fail → implement → pass.
- [ ] Step 5: Commit `feat(server): undo journal for agent changes`.

### Task 5: Session store + system prompt

**Files:** Create `server/src/ai/sessions.ts`, `server/src/ai/prompt.ts`; Test `server/test/sessions.test.ts`, `server/test/prompt.test.ts`.

**Interfaces — Produces:**
```ts
export interface StoredSession { id: string; title: string; createdAt: string; updatedAt: string; model: string; system: string; messages: Anthropic.Beta.BetaMessageParam[]; seen: Record<string,string>; turns: AiTurn[]; usage: AiUsage }
export class SessionStore {
  static open(dir: string | null): Promise<SessionStore>; // null → memory only; creates dir; loads all; repairs
  create(init: { model: string; system: string }): Promise<StoredSession>;
  get(id: string): StoredSession | undefined;
  list(): StoredSession[];               // updatedAt desc
  save(s: StoredSession): Promise<void>; // atomic tmp+rename; bumps updatedAt
  delete(id: string): Promise<boolean>;
}
export function repairSession(s: StoredSession): boolean; // running turns → stopped (error 'Interrupted (server restarted)'); trailing assistant with tool_use lacking results → append user tool_result is_error "Interrupted"; returns changed
export function toPublic(s: StoredSession, running: boolean): AiSession;
// prompt.ts
export function buildSystemPrompt(p: { claudeMd?: string; profile?: string }): string;
export function buildUserText(prompt: string, ctx: { path?: string; selection?: string }): string;
```
Ids: `randomBytes(12).toString('base64url')`; validate id param `/^[A-Za-z0-9_-]{16}$/` in store `get`/`delete`.

- [ ] Step 1: tests: create→get→list order; persisted across `SessionStore.open(sameDir)`; delete removes file; bad id → undefined; **repairs dangling tool_use** (session whose last message is assistant with a `tool_use` block + a `running` turn → after reopen, last message is user with matching `tool_result` is_error, turn status `stopped`); corrupt JSON file skipped. Prompt: includes CLAUDE.md and profile sections only when present; user text includes `Open note:` and selection only when given.
- [ ] Step 2–4. Step 5: Commit `feat(server): persisted agent sessions and system prompt`.

### Task 6: Agent loop + RunManager

**Files:** Create `server/src/ai/agent.ts`, `server/src/ai/runs.ts`; Test `server/test/agent.test.ts`, `server/test/runs.test.ts`, helper `server/test/fake-anthropic.ts`.

**Interfaces — Produces:**
```ts
// agent.ts
export interface AgentConfig { model: string; effort: 'low'|'medium'|'high'|'xhigh'|'max'; maxRounds: number; fallbacks: boolean }
export interface AgentStream extends AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> { finalMessage(): Promise<Anthropic.Beta.BetaMessage> }
export interface AgentClient { beta: { messages: { stream(params: Anthropic.Beta.MessageCreateParamsStreaming | object, opts?: { signal?: AbortSignal }): AgentStream } } }
export type AgentEmit = (e: Exclude<AgentEvent, { type: 'snapshot' | 'turn_start' | 'turn_end' }>) => void;
export async function runAgent(a: { client: AgentClient; config: AgentConfig; system: string; messages: Anthropic.Beta.BetaMessageParam[]; tools: VaultTools; turnId: string; signal: AbortSignal; emit: AgentEmit }): Promise<{ status: 'done' | 'stopped' | 'error'; error?: string }>;
export function buildParams(config: AgentConfig, system: string, messages: BetaMessageParam[]): object; // exported for tests
// runs.ts
export class RunManager {
  constructor(d: { store: SessionStore; client: AgentClient | null; config: AgentConfig; ctx: VaultCtx });
  isRunning(id: string): boolean;
  start(id: string, input: { prompt: string; path?: string; selection?: string }): AiTurn; // throws RunBusyError / NotConfiguredError
  stop(id: string): boolean;
  subscribe(id: string, fn: (e: AgentEvent) => void): () => void; // immediately sends snapshot
  undo(id: string, turnId: string, ids?: string[], resolution?: UndoResolution): Promise<UndoResult[]>; // RunBusyError while running
  shutdown(): Promise<void>;
}
export class RunBusyError extends Error {} ; export class NotConfiguredError extends Error {}
```
Loop per spec §Loop. Item ids `${round}.${blockIndex}`; custom tool items `t:${tool_use.id}`; server tools (`server_tool_use` blocks in final message) → tool_start + tool_end with summary `web_search "q"` / `web_fetch url`. Usage folded from `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) per round. Error mapping: `Anthropic.AuthenticationError` → "Invalid ANTHROPIC_API_KEY", `RateLimitError` → "Rate limited by the Claude API — try again shortly", `APIError` → `Claude API error (status): message`, abort → stopped. Changes from tool outcomes: assign id `randomBytes(6)`, emit `change`. RunManager: on start builds user message `{role:'user', content: buildUserText(...)}`, appends to `session.messages`, sets title if first turn, pushes turn, persists; folds every event into `session.turns` with `foldEvent`, also usage into `session.usage`; persist debounced 500 ms and on end; subscribers get `snapshot` first.

Fake client helper: `fakeClient(script: Array<BetaMessage | Error | ((params)=>BetaMessage)>)` → stream yields `message_start`, per block `content_block_start`/delta (text_delta / thinking_delta / input_json_delta)/`content_block_stop`, `message_delta`, `message_stop`; records `calls` (deep-cloned params); honours `signal` (rejects with `APIUserAbortError`-like error when aborted).

- [ ] Step 1: agent tests: text-only turn → emits text_delta, appends assistant content, `done`; tool round trip (`read` then end_turn) → tool_start/tool_end, second call's messages end with user `tool_result` for that id; two tool_use blocks → both results in ONE user message; pause_turn → re-request without extra user message; `max_tokens` with tool_use → error, tool not executed; refusal → status done with error text "declined"; abort during tool execution → remaining tool_results `Interrupted by the user`, status stopped, history valid (every tool_use has a result); round cap → error "round limit"; API 401 → error message; params include betas, fallbacks 'default', `context_management`, web tools, thinking display summarized; `fallbacks:false` omits fallbacks + its beta; messages from earlier rounds are byte-identical in later calls (append-only).
- [ ] runs tests: start → turn_start, events, turn_end persisted (`store.get(id).turns[0].status==='done'`); second start while running → RunBusyError; **late subscriber gets snapshot** containing streamed text so far (use a fake whose stream waits on a deferred); stop → stopped; undo delegates and marks records; shutdown aborts and persists.
- [ ] Step 2–4. Step 5: Commit `feat(server): Claude agent loop and run manager`.

### Task 7: HTTP routes + wiring, remove Gemini

**Files:** Rewrite `server/src/routes/ai-routes.ts`; Modify `server/src/app.ts` (AppOpts.ai type, onClose shutdown), `server/src/main.ts` (env), `server/package.json` (dep, done), `docker-compose.yml`; Delete `server/src/ai/gemini.ts`, `server/src/ai/skill.ts`, `server/test/ai.test.ts`; Test `server/test/ai-routes.test.ts`.

**Interfaces — Produces (HTTP, per spec table)** and:
```ts
export interface AiOpts { apiKey?: string; model?: string; effort?: string; maxRounds?: number; fallbacks?: boolean; profileNote?: string; dataDir?: string | null; client?: AgentClient }
```
`client` defaults to `new Anthropic({ apiKey })` when apiKey set. Sessions dir `${dataDir}/ai-sessions` (null → memory). New session reads `CLAUDE.md` + profile via `readNote` (missing → undefined), freezes `buildSystemPrompt`. SSE handler: hijack, headers as `/api/events`, `retry: 3000`, subscribe → `data: JSON\n\n`, ping 25 s, unsubscribe on close. Route errors: unknown session 404; RunBusyError 409; NotConfiguredError 503; prompt empty 400; path bad (`badNotePath`) 400; selection max 100k chars.

- [ ] Step 1: tests with fake client: status (enabled false w/o key, claudeMdExists); create/list/get/delete (delete while running 409); run → poll `GET session` until turn status done, text present; concurrent run 409; run without key 503; SSE: `app.listen({port:0})`, fetch events stream, read first chunk → `snapshot`; stop endpoint; undo endpoint returns results; **public app** (`buildPublicApp`) `GET /api/ai/status` → 404.
- [ ] Step 2–4; also `npx vitest run --project server` all green and `tsc -p server --noEmit` clean.
- [ ] Step 5: Commit `feat(server): agent session API; remove Gemini`.

### Task 8: Web API client

**Files:** Modify `web/src/api.ts`; Test `web/test/api.test.ts` (replace streamAi tests).

**Produces:**
```ts
api.aiStatus(); api.aiSessions(): Promise<AiSessionSummary[]>; api.aiCreateSession(): Promise<{ id: string }>;
api.aiSession(id): Promise<AiSession>; api.aiDeleteSession(id); api.aiRun(id, { prompt, path?, selection? }): Promise<{ turnId: string }>;
api.aiStop(id); api.aiUndo(id, turnId, { changeIds?, resolution? }): Promise<{ results: UndoResult[] }>;
export function aiEventsUrl(id: string): string;
export function apiErrorMessage(err: unknown, fallback: string): string; // body.error when present
```
- [ ] Steps: tests for URL/method/body of aiRun, aiUndo, error message extraction → implement → pass → commit `feat(web): agent API client`.

### Task 9: AiPanel rewrite + App wiring + styles

**Files:** Rewrite `web/src/components/AiPanel.tsx`; Create `web/src/components/ai/TurnView.tsx` (user bubble, items, change card), `web/src/components/ai/useAgentSession.ts` (session state + EventSource + fold); Modify `web/src/App.tsx`, `web/src/theme.css`; Test rewrite `web/test/aipanel.test.tsx`.

**Interfaces:**
```ts
export interface AiPanelProps { status: AiStatus | null; path: string | null; getSelection(): string; saveNow(): Promise<void>; onOpenNote(target: string): void; onOpenProfile(): void; onClose(): void }
export function useAgentSession(enabled: boolean): { sessions: AiSessionSummary[]; session: AiSession | null; select(id: string | null): void; newSession(): void; send(input: { prompt: string; path?: string; selection?: string }): Promise<void>; stop(): void; undo(turnId: string, changeIds?: string[], resolution?: UndoResolution): Promise<UndoResult[]>; remove(id: string): Promise<void>; error: string | null }
```
`send` creates a session lazily when none selected. Last session id in `localStorage['noteviewer.ai.session']` (try/catch). EventSource per selected session; `snapshot` replaces session; other events `foldEvent`; on `turn_end` refresh sessions list. Wikilink clicks: rendered HTML from `renderMarkdown` — intercept clicks on `a` elements with `data-wikilink`/`href` per existing `md/wikilinks.ts` output and call `onOpenNote(target)`. Change card: per-record row with op icon, path, `+a −r`, Undo; "Undo all"; conflict results show buttons Restore as copy / Overwrite / Skip that re-call undo with that resolution for that id. Usage line with `estimateCost`.
App: remove `applyAi`, `ApplyMode`, `blockSeparator` if unused; pass `saveNow={editor.saveNow}` and `onOpenNote={(t) => { const r = tree && resolveLink(tree, t); if (r) void openNote(r); }}`.

- [ ] Step 1: tests (mock `../src/api`, stub global `EventSource` with a controllable fake): disabled state text mentions `ANTHROPIC_API_KEY`; sending calls `saveNow` before `aiRun` and creates a session when none; snapshot + text_delta render assistant text; tool row shows summary; quick action "Tidy up" sends its preset with path; Stop calls `aiStop`; change card Undo calls `aiUndo` with change id; conflict result shows "Restore as copy" and clicking re-calls with `resolution:'copy'`; session list "New session" clears log.
- [ ] Step 2–4; `npm test` all green; `npm run typecheck` clean; `npm run build -w web` OK.
- [ ] Step 5: Commit `feat(web): Claude agent panel with sessions, tool log and undo`.

### Task 10: Verification & docs

- [ ] `npm test`, `npm run typecheck`, `npm run build -w web`, `npm run test:e2e` (existing e2e must pass; no AI e2e).
- [ ] Live smoke (if `ANTHROPIC_API_KEY` available locally): run server against a temp copy of a vault, ask "list my top-level folders and create Test/Hello.md with a greeting", verify file + undo.
- [ ] Update memory file for the project; commit `chore: docs for Claude agent env`.
