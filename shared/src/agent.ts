/**
 * Wire types for the Claude vault agent, shared by the server (which folds
 * run events into the persisted session) and the web panel (which folds the
 * same events streamed over SSE).
 */

export interface AiStatus {
  /** false when the server has no ANTHROPIC_API_KEY */
  enabled: boolean;
  model: string;
  /** vault-relative path of the note whose contents personalise the assistant */
  profileNote: string;
  profileExists: boolean;
  /** a CLAUDE.md at the vault root is loaded into new sessions */
  claudeMdExists: boolean;
  /** model ids a run may use (the default first) */
  models: string[];
  /** default effort for runs */
  effort: AiEffort;
}

export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const AI_EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Models offered in the panel, with a short description for the picker. */
export const AI_MODELS: { id: string; label: string; note: string }[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: '$4 / $20 per MTok' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: '$2 / $10 per MTok' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: '$0.10 / $0.50 per MTok (5× above 100K-token prompts)' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', note: 'most capable · $10 / $50 per MTok' },
];

export function modelLabel(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** estimated USD, priced per request; undefined once any request was unpriced */
  costUsd?: number;
}

export const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd === undefined || b.costUsd === undefined ? undefined : a.costUsd + b.costUsd,
  };
}

export type TurnItem =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'thinking'; text: string }
  | {
      id: string;
      kind: 'tool';
      name: string;
      input: unknown;
      done: boolean;
      summary?: string;
      detail?: string;
      isError?: boolean;
    };

export type ChangeOp = 'create' | 'write' | 'edit' | 'move' | 'delete';

/** One vault mutation made by the agent, with what it takes to undo it. */
export interface ChangeRecord {
  id: string;
  op: ChangeOp;
  /** path after the op (for a move: the destination) */
  path: string;
  /** move source */
  from?: string;
  /** content before the op; null when the op created the file */
  before: string | null;
  /** hash right after the op; null when the op removed the file */
  afterHash: string | null;
  trashedTo?: string;
  /** move: notes whose links were rewritten */
  rewritten?: string[];
  undone?: boolean;
  /** how the record was resolved when `undone` is set */
  undoStatus?: 'undone' | 'copied' | 'skipped';
  /** where the old version was restored when undoStatus is 'copied' */
  copyPath?: string;
  added: number;
  removed: number;
}

export type TurnStatus = 'running' | 'done' | 'stopped' | 'error';

/** One user prompt and the agent run it started. */
export interface AiTurn {
  id: string;
  prompt: string;
  context: { path?: string; selection?: string };
  items: TurnItem[];
  changes: ChangeRecord[];
  status: TurnStatus;
  error?: string;
  usage?: AiUsage;
  /** model and effort the run used */
  model?: string;
  effort?: AiEffort;
  startedAt: string;
  endedAt?: string;
}

export interface AiSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  running: boolean;
}

export interface AiSession extends AiSessionSummary {
  createdAt: string;
  model: string;
  turns: AiTurn[];
  usage: AiUsage;
}

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

export type UndoResolution = 'copy' | 'overwrite' | 'skip';

export interface UndoResult {
  id: string;
  status: 'undone' | 'conflict' | 'skipped' | 'copied' | 'failed';
  copyPath?: string;
  message?: string;
}

function appendDelta(t: AiTurn, kind: 'text' | 'thinking', itemId: string, text: string): AiTurn {
  const idx = t.items.findIndex((i) => i.id === itemId);
  if (idx === -1) return { ...t, items: [...t.items, { id: itemId, kind, text }] };
  const items = t.items.slice();
  const item = items[idx]!;
  if (item.kind === 'tool') return t;
  items[idx] = { ...item, text: item.text + text };
  return { ...t, items };
}

/**
 * Apply one event to a session's turns, returning a new array. `snapshot`
 * replaces the whole session and is the caller's business.
 */
export function foldEvent(turns: AiTurn[], e: AgentEvent): AiTurn[] {
  if (e.type === 'snapshot') return turns;
  if (e.type === 'turn_start') return [...turns, e.turn];
  const idx = turns.findIndex((t) => t.id === e.turnId);
  if (idx === -1) return turns;
  const t = turns[idx]!;
  let next: AiTurn;
  switch (e.type) {
    case 'text_delta':
    case 'thinking_delta':
      next = appendDelta(t, e.type === 'text_delta' ? 'text' : 'thinking', e.itemId, e.text);
      break;
    case 'tool_start':
      next = { ...t, items: [...t.items, { id: e.itemId, kind: 'tool', name: e.name, input: e.input, done: false }] };
      break;
    case 'tool_end':
      next = {
        ...t,
        items: t.items.map((i) =>
          i.id === e.itemId && i.kind === 'tool'
            ? { ...i, done: true, summary: e.summary, detail: e.detail, isError: e.isError }
            : i,
        ),
      };
      break;
    case 'change':
      next = { ...t, changes: [...t.changes, e.record] };
      break;
    case 'usage':
      next = { ...t, usage: e.usage };
      break;
    case 'turn_end':
      next = { ...t, status: e.status, error: e.error, endedAt: new Date().toISOString() };
      break;
  }
  const out = turns.slice();
  out[idx] = next;
  return out;
}

export type QuickPromptId = 'summarize' | 'tidy' | 'tasks' | 'links' | 'continue';

/** Preset prompts behind the panel's quick-action buttons. */
export const QUICK_PROMPTS: { id: QuickPromptId; label: string; title: string; prompt: string }[] = [
  {
    id: 'summarize',
    label: 'Summarize',
    title: 'TL;DR and key points',
    prompt: "Summarise the open note (or the selection). Reply in chat; don't edit files.",
  },
  {
    id: 'tidy',
    label: 'Tidy up',
    title: 'Restructure and fix language, keeping all content',
    prompt:
      "Tidy up the open note (or the selected part): fix language, add structure, convert obvious to-dos to tasks. Keep all information, links, tags, frontmatter and the author's voice. Edit the file.",
  },
  {
    id: 'tasks',
    label: 'Action items',
    title: 'Collect to-dos as a task list in the note',
    prompt:
      "Extract every action item from the open note as a task list and append it under an '## Action items' heading (skip ones already present). Edit the file.",
  },
  {
    id: 'links',
    label: 'Tags & links',
    title: 'Add fitting tags and [[links]] to related notes',
    prompt:
      'Find related notes in the vault and add fitting existing #tags and [[links]] to the open note. Edit the file and tell me what you added.',
  },
  {
    id: 'continue',
    label: 'Continue',
    title: 'Keep writing in the same style',
    prompt: 'Continue writing the open note from where it ends, in the same style. Append to the file.',
  },
];

interface RateCard {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** USD per million tokens (5-minute cache writes). */
const PRICES: Record<string, { base: RateCard; long?: { above: number; rates: RateCard } }> = {
  'claude-opus-5-5': { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  'claude-sonnet-5-5': { base: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  'claude-haiku-5-5': {
    base: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    // prompts over 100K tokens are billed on a second rate card
    long: { above: 100_000, rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  },
  'claude-fable-5-1': { base: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
};

/** Estimated USD cost of ONE request's usage, or undefined for models without a known price. */
export function estimateCost(model: string, u: AiUsage): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const p = price.long && prompt > price.long.above ? price.long.rates : price.base;
  return (
    (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
