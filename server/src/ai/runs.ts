/**
 * Agent runs as background jobs, decoupled from the HTTP request that started
 * them: closing the tab doesn't stop a run. Every event is folded into the
 * in-memory session (persisted, debounced) and fanned out to subscribers,
 * who first receive a snapshot so a reconnecting client never double-applies.
 */

import { randomBytes } from 'node:crypto';
import { ZERO_USAGE, addUsage, foldEvent, type AgentEvent, type AiEffort, type AiTurn, type UndoResolution, type UndoResult } from '@noteviewer/shared';
import type { VaultCtx } from '../vault/ops.js';
import { runAgent, type AgentClient, type AgentConfig } from './agent.js';
import { undoChanges } from './journal.js';
import { buildUserText } from './prompt.js';
import { toPublic, type SessionStore, type StoredSession } from './sessions.js';
import { VaultTools } from './tools.js';

export class RunBusyError extends Error {
  constructor() {
    super('A run is already in progress for this session');
  }
}
export class NotConfiguredError extends Error {
  constructor() {
    super('AI is not configured (set ANTHROPIC_API_KEY)');
  }
}
export class SessionNotFoundError extends Error {
  constructor() {
    super('session not found');
  }
}

interface ActiveRun {
  abort: AbortController;
  done: Promise<void>;
}

const PERSIST_DEBOUNCE_MS = 500;
const TITLE_MAX = 80;

export class RunManager {
  private active = new Map<string, ActiveRun>();
  private listeners = new Map<string, Set<(e: AgentEvent) => void>>();
  private persistTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly d: { store: SessionStore; client: AgentClient | null; config: AgentConfig; ctx: VaultCtx },
  ) {}

  isRunning(id: string): boolean {
    return this.active.has(id);
  }

  private session(id: string): StoredSession {
    const s = this.d.store.get(id);
    if (!s) throw new SessionNotFoundError();
    return s;
  }

  start(
    id: string,
    input: { prompt: string; path?: string; selection?: string; model?: string; effort?: AiEffort },
  ): AiTurn {
    if (!this.d.client) throw new NotConfiguredError();
    const session = this.session(id);
    if (this.active.has(id)) throw new RunBusyError();

    const context: AiTurn['context'] = {};
    if (input.path) context.path = input.path;
    if (input.selection?.trim()) context.selection = input.selection;
    const config: AgentConfig = {
      ...this.d.config,
      model: input.model ?? this.d.config.model,
      effort: input.effort ?? this.d.config.effort,
    };
    const turn: AiTurn = {
      id: randomBytes(6).toString('base64url'),
      prompt: input.prompt,
      context,
      model: config.model,
      effort: config.effort,
      items: [],
      changes: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    if (session.turns.length === 0) {
      const oneLine = input.prompt.replace(/\s+/g, ' ').trim();
      session.title = oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1)}…` : oneLine;
    }
    session.messages.push({ role: 'user', content: buildUserText(input.prompt, context) });

    const abort = new AbortController();
    const run: ActiveRun = { abort, done: Promise.resolve() };
    this.active.set(id, run);
    this.publish(session, { type: 'turn_start', turn });

    run.done = (async () => {
      let result: { status: 'done' | 'stopped' | 'error'; error?: string };
      try {
        result = await runAgent({
          client: this.d.client!,
          config,
          system: session.system,
          messages: session.messages,
          tools: new VaultTools(this.d.ctx, session.seen),
          turnId: turn.id,
          signal: abort.signal,
          emit: (e) => this.publish(session, e),
        });
      } catch (err) {
        result = { status: 'error', error: err instanceof Error ? err.message : String(err) };
      }
      this.active.delete(id);
      this.publish(session, { type: 'turn_end', turnId: turn.id, status: result.status, error: result.error });
      await this.persistNow(session);
    })();
    return turn;
  }

  stop(id: string): boolean {
    const run = this.active.get(id);
    if (!run) return false;
    run.abort.abort();
    return true;
  }

  /** Sends a snapshot of the session immediately, then live events. */
  subscribe(id: string, fn: (e: AgentEvent) => void): () => void {
    const session = this.session(id);
    fn({ type: 'snapshot', session: toPublic(session, this.isRunning(id)) });
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.listeners.get(id) === set) this.listeners.delete(id);
    };
  }

  async undo(id: string, turnId: string, ids?: string[], resolution?: UndoResolution): Promise<UndoResult[]> {
    const session = this.session(id);
    if (this.active.has(id)) throw new RunBusyError();
    const turn = session.turns.find((t) => t.id === turnId);
    if (!turn) throw new SessionNotFoundError();
    const results = await undoChanges(this.d.ctx, turn.changes, ids, resolution);
    // changes are mutated in place; give the UI a fresh copy
    session.turns = session.turns.map((t) => (t === turn ? { ...t, changes: t.changes.map((c) => ({ ...c })) } : t));
    await this.persistNow(session);
    this.broadcast(id, { type: 'snapshot', session: toPublic(session, false) });
    return results;
  }

  /** Abort every run and wait for their sessions to be saved. */
  async shutdown(): Promise<void> {
    const runs = [...this.active.values()];
    for (const r of runs) r.abort.abort();
    await Promise.all(runs.map((r) => r.done));
  }

  private publish(session: StoredSession, e: AgentEvent): void {
    session.turns = foldEvent(session.turns, e);
    if (e.type === 'usage') {
      session.usage = session.turns.reduce((u, t) => (t.usage ? addUsage(u, t.usage) : u), { ...ZERO_USAGE });
    }
    this.broadcast(session.id, e);
    this.schedulePersist(session);
  }

  private broadcast(id: string, e: AgentEvent): void {
    for (const fn of this.listeners.get(id) ?? []) {
      try {
        fn(e);
      } catch (err) {
        console.error('ai: subscriber failed', err);
      }
    }
  }

  private schedulePersist(session: StoredSession): void {
    if (this.persistTimers.has(session.id)) return;
    this.persistTimers.set(
      session.id,
      setTimeout(() => {
        this.persistTimers.delete(session.id);
        void this.d.store.save(session).catch((err) => console.error('ai: failed to save session', err));
      }, PERSIST_DEBOUNCE_MS),
    );
  }

  private async persistNow(session: StoredSession): Promise<void> {
    const timer = this.persistTimers.get(session.id);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(session.id);
    }
    // a deleted session stays deleted
    if (this.d.store.get(session.id) === session) await this.d.store.save(session);
  }
}
