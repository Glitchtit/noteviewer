/**
 * Agent sessions, one JSON file each under <data>/ai-sessions. A session holds
 * the full API history (append-only, replayed verbatim on every request), the
 * system prompt frozen at creation, the read-before-write hash ledger, and a
 * UI transcript of turns.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { ZERO_USAGE, type AiSession, type AiTurn, type AiUsage } from '@noteviewer/shared';

export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  system: string;
  messages: BetaMessageParam[];
  seen: Record<string, string>;
  turns: AiTurn[];
  usage: AiUsage;
}

const ID_RE = /^[A-Za-z0-9_-]{16}$/;

export function isSessionId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * Make a session loaded after a crash consistent: running turns become
 * stopped, and a trailing assistant turn whose tool calls never got results
 * gets "interrupted" results so the history is valid to send again.
 */
export function repairSession(s: StoredSession): boolean {
  let changed = false;
  for (const t of s.turns) {
    if (t.status === 'running') {
      t.status = 'stopped';
      t.error = 'Interrupted (server restarted)';
      t.endedAt ??= new Date().toISOString();
      changed = true;
    }
  }
  const last = s.messages.at(-1);
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const results: BetaToolResultBlockParam[] = last.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        type: 'tool_result',
        tool_use_id: (b as { id: string }).id,
        is_error: true,
        content: 'Interrupted (server restarted)',
      }));
    if (results.length) {
      s.messages.push({ role: 'user', content: results });
      changed = true;
    }
  }
  return changed;
}

export function toPublic(s: StoredSession, running: boolean): AiSession {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    model: s.model,
    turns: s.turns,
    usage: s.usage,
    running,
  };
}

export class SessionStore {
  private sessions = new Map<string, StoredSession>();
  /** per-session write queue so overlapping saves land in order */
  private writes = new Map<string, Promise<void>>();

  private constructor(private dir: string | null) {}

  /** `dir` null keeps sessions in memory only (tests, no data dir). */
  static async open(dir: string | null): Promise<SessionStore> {
    const store = new SessionStore(dir);
    if (dir) {
      await fs.mkdir(dir, { recursive: true });
      for (const name of await fs.readdir(dir)) {
        const id = name.replace(/\.json$/, '');
        if (!name.endsWith('.json') || !isSessionId(id)) continue;
        try {
          const s = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as StoredSession;
          if (s.id !== id || !Array.isArray(s.messages)) continue;
          store.sessions.set(id, s);
          if (repairSession(s)) await store.write(s);
        } catch (err) {
          console.error(`ai-sessions: skipping unreadable ${name}:`, err);
        }
      }
    }
    return store;
  }

  async create(init: { model: string; system: string }): Promise<StoredSession> {
    const now = new Date().toISOString();
    const s: StoredSession = {
      id: randomBytes(12).toString('base64url'),
      title: 'New session',
      createdAt: now,
      updatedAt: now,
      model: init.model,
      system: init.system,
      messages: [],
      seen: {},
      turns: [],
      usage: { ...ZERO_USAGE },
    };
    this.sessions.set(s.id, s);
    await this.write(s);
    return s;
  }

  get(id: string): StoredSession | undefined {
    return isSessionId(id) ? this.sessions.get(id) : undefined;
  }

  list(): StoredSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(s: StoredSession): Promise<void> {
    s.updatedAt = new Date().toISOString();
    await this.write(s);
  }

  async delete(id: string): Promise<boolean> {
    if (!this.get(id)) return false;
    this.sessions.delete(id);
    await this.writes.get(id);
    if (this.dir) await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }

  private write(s: StoredSession): Promise<void> {
    const dir = this.dir;
    if (!dir) return Promise.resolve();
    const prev = this.writes.get(s.id) ?? Promise.resolve();
    // serialise at write time, so a queued write always stores the latest state
    const next = prev.then(async () => {
      if (this.sessions.get(s.id) !== s) return; // deleted meanwhile
      const file = path.join(dir, `${s.id}.json`);
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(s), 'utf8');
      await fs.rename(tmp, file);
    });
    const tracked = next.catch((err) => console.error(`ai-sessions: failed to save ${s.id}:`, err));
    this.writes.set(s.id, tracked);
    void tracked.then(() => {
      if (this.writes.get(s.id) === tracked) this.writes.delete(s.id);
    });
    return next;
  }
}
