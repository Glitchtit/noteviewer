import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { AiSessionSummary, AiStatus, UndoResolution } from '@noteviewer/shared';
import { readNote } from '../vault/files.js';
import type { AgentClient, AgentConfig, Effort } from '../ai/agent.js';
import { buildSystemPrompt } from '../ai/prompt.js';
import { NotConfiguredError, RunBusyError, RunManager, SessionNotFoundError } from '../ai/runs.js';
import { SessionStore, toPublic } from '../ai/sessions.js';
import { badNotePath } from './params.js';

export interface AiOpts {
  /** Anthropic API key; runs answer 503 when unset */
  apiKey?: string;
  model?: string;
  effort?: string;
  maxRounds?: number;
  /** server-side refusal fallback; default on */
  fallbacks?: boolean;
  /** vault-relative path of the user's profile note */
  profileNote?: string;
  /** sessions are stored in <dataDir>/ai-sessions; omitted → memory only */
  dataDir?: string;
  /** injectable for tests */
  client?: AgentClient;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_PROFILE_NOTE = 'AI Profile.md';
const CLAUDE_MD = 'CLAUDE.md';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_PROMPT = 100_000;
const MAX_SELECTION = 100_000;

async function tryRead(root: string, rel: string): Promise<string | undefined> {
  try {
    return (await readNote(root, rel)).content;
  } catch {
    return undefined;
  }
}

export async function aiRoutes(app: FastifyInstance, opts: AiOpts): Promise<void> {
  const config: AgentConfig = {
    model: opts.model || DEFAULT_MODEL,
    effort: EFFORTS.includes(opts.effort as Effort) ? (opts.effort as Effort) : 'high',
    maxRounds: opts.maxRounds && opts.maxRounds > 0 ? opts.maxRounds : 60,
    fallbacks: opts.fallbacks ?? true,
  };
  const profileNote = opts.profileNote || DEFAULT_PROFILE_NOTE;
  const client: AgentClient | null = opts.apiKey
    ? (opts.client ?? (new Anthropic({ apiKey: opts.apiKey }) as unknown as AgentClient))
    : null;
  const store = await SessionStore.open(opts.dataDir ? path.join(opts.dataDir, 'ai-sessions') : null);
  const runs = new RunManager({ store, client, config, ctx: app });
  app.addHook('onClose', () => runs.shutdown());

  app.get('/api/ai/status', async () => {
    const status: AiStatus = {
      enabled: client !== null,
      model: config.model,
      profileNote,
      profileExists: app.index.getMeta(profileNote) !== undefined,
      claudeMdExists: app.index.getMeta(CLAUDE_MD) !== undefined,
    };
    return status;
  });

  app.get('/api/ai/sessions', async () =>
    store.list().map((s): AiSessionSummary => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, running: runs.isRunning(s.id) })),
  );

  app.post('/api/ai/sessions', async (_req, reply) => {
    const system = buildSystemPrompt({
      claudeMd: await tryRead(app.vaultRoot, CLAUDE_MD),
      profile: await tryRead(app.vaultRoot, profileNote),
    });
    const s = await store.create({ model: config.model, system });
    return reply.code(201).send({ id: s.id });
  });

  app.get<{ Params: { id: string } }>('/api/ai/sessions/:id', async (req, reply) => {
    const s = store.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'session not found' });
    return toPublic(s, runs.isRunning(s.id));
  });

  app.delete<{ Params: { id: string } }>('/api/ai/sessions/:id', async (req, reply) => {
    if (runs.isRunning(req.params.id)) return reply.code(409).send({ error: 'stop the run first' });
    if (!(await store.delete(req.params.id))) return reply.code(404).send({ error: 'session not found' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { prompt: string; path?: string; selection?: string } }>(
    '/api/ai/sessions/:id/runs',
    {
      schema: {
        body: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string', maxLength: MAX_PROMPT },
            path: { type: 'string' },
            selection: { type: 'string', maxLength: MAX_SELECTION },
          },
        },
      },
    },
    async (req, reply) => {
      const { prompt, path: notePath, selection } = req.body;
      if (!prompt.trim()) return reply.code(400).send({ error: 'prompt required' });
      if (notePath !== undefined && badNotePath(notePath)) return reply.code(400).send({ error: 'bad path' });
      try {
        const turn = runs.start(req.params.id, { prompt: prompt.trim(), path: notePath, selection });
        return reply.code(202).send({ turnId: turn.id });
      } catch (err) {
        if (err instanceof SessionNotFoundError) return reply.code(404).send({ error: err.message });
        if (err instanceof RunBusyError) return reply.code(409).send({ error: err.message });
        if (err instanceof NotConfiguredError) return reply.code(503).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/ai/sessions/:id/stop', async (req, reply) => {
    if (!store.get(req.params.id)) return reply.code(404).send({ error: 'session not found' });
    return { stopped: runs.stop(req.params.id) };
  });

  app.post<{
    Params: { id: string; turnId: string };
    Body: { changeIds?: string[]; resolution?: UndoResolution };
  }>(
    '/api/ai/sessions/:id/turns/:turnId/undo',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            changeIds: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
            resolution: { type: 'string', enum: ['copy', 'overwrite', 'skip'] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const results = await runs.undo(req.params.id, req.params.turnId, req.body?.changeIds, req.body?.resolution);
        return { results };
      } catch (err) {
        if (err instanceof SessionNotFoundError) return reply.code(404).send({ error: 'not found' });
        if (err instanceof RunBusyError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/ai/sessions/:id/events', (req, reply) => {
    if (!store.get(req.params.id)) return reply.code(404).send({ error: 'session not found' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');
    const off = runs.subscribe(req.params.id, (e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
}
