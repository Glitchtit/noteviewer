import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import type { AiStatus } from '@noteviewer/shared';
import { readNote } from '../vault/files.js';
import { streamGemini, GeminiError } from '../ai/gemini.js';
import { AI_ACTIONS, buildContents, buildSystemPrompt, type AiAction, type ChatTurn } from '../ai/skill.js';
import { badNotePath } from './vault-routes.js';

export interface AiOpts {
  /** Gemini API key; AI endpoints answer 503 when unset */
  apiKey?: string;
  model?: string;
  /** vault-relative path of the user's profile note */
  profileNote?: string;
  /** injectable for tests */
  fetch?: typeof fetch;
}

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_PROFILE_NOTE = 'AI Profile.md';

/** Per-document cap so one huge note can't blow up the request. */
const MAX_NOTE_CHARS = 200_000;
const MAX_RELATED_CHARS = 12_000;
const RELATED_NOTES = 6;

interface AiBody {
  action: AiAction;
  path?: string;
  content?: string;
  selection?: string;
  prompt?: string;
  history?: ChatTurn[];
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

async function tryRead(root: string, rel: string): Promise<string | undefined> {
  try {
    return (await readNote(root, rel)).content;
  } catch {
    return undefined;
  }
}

export async function aiRoutes(app: FastifyInstance, opts: AiOpts): Promise<void> {
  const model = opts.model || DEFAULT_MODEL;
  const profileNote = opts.profileNote || DEFAULT_PROFILE_NOTE;

  app.get('/api/ai/status', async () => {
    const status: AiStatus = {
      enabled: Boolean(opts.apiKey),
      model,
      profileNote,
      profileExists: app.index.getMeta(profileNote) !== undefined,
    };
    return status;
  });

  app.post<{ Body: AiBody }>(
    '/api/ai',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: [...AI_ACTIONS] },
            path: { type: 'string' },
            content: { type: 'string' },
            selection: { type: 'string' },
            prompt: { type: 'string' },
            history: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                required: ['role', 'text'],
                properties: { role: { type: 'string', enum: ['user', 'model'] }, text: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (!opts.apiKey) return reply.code(503).send({ error: 'AI is not configured (set GEMINI_API_KEY)' });
      const body = req.body;
      if (body.path !== undefined && badNotePath(body.path)) return reply.code(400).send({ error: 'bad path' });
      if ((body.action === 'ask' || body.action === 'ask-vault') && !body.prompt?.trim()) {
        return reply.code(400).send({ error: 'prompt required' });
      }

      const notes = app.index.allNotes();
      const tagCounts = new Map<string, number>();
      for (const n of notes) for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 300);
      const noteNames = [...new Set(notes.map((n) => path.posix.basename(n.path, '.md')))].sort();

      let related: { path: string; content: string }[] | undefined;
      if (body.action === 'ask-vault') {
        related = [];
        for (const hit of app.index.search(body.prompt!)) {
          if (related.length >= RELATED_NOTES) break;
          if (hit.path === body.path || hit.path === profileNote) continue;
          const content = await tryRead(app.vaultRoot, hit.path);
          if (content !== undefined) related.push({ path: hit.path, content: clip(content, MAX_RELATED_CHARS) });
        }
      }

      const profile = await tryRead(app.vaultRoot, profileNote);
      const system = buildSystemPrompt({ profile });
      const contents = buildContents({
        action: body.action,
        path: body.path,
        content: body.content === undefined ? undefined : clip(body.content, MAX_NOTE_CHARS),
        selection: body.selection,
        prompt: body.prompt,
        history: body.history,
        noteNames,
        tags,
        related,
      });

      const abort = new AbortController();
      // the response (not the request, whose 'close' fires once the body is
      // read) closing early means the client went away: stop generating
      reply.raw.on('close', () => abort.abort());
      const stream = streamGemini({ apiKey: opts.apiKey, model, fetch: opts.fetch }, system, contents, abort.signal);

      // Pull the first chunk before committing to a 200 so upstream failures
      // (bad key, quota, blocked prompt) surface as a proper error status.
      let first: IteratorResult<string>;
      try {
        first = await stream.next();
      } catch (err) {
        const status = err instanceof GeminiError && err.status === 429 ? 429 : 502;
        req.log.warn({ err }, 'gemini request failed');
        return reply.code(status).send({ error: err instanceof Error ? err.message : 'AI request failed' });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      });
      if (!first.done) reply.raw.write(first.value);
      try {
        for await (const text of stream) reply.raw.write(text);
      } catch (err) {
        if (!abort.signal.aborted) {
          reply.raw.write(`\n\n> [!error] AI response interrupted\n> ${err instanceof Error ? err.message : 'unknown error'}\n`);
        }
      }
      reply.raw.end();
    },
  );
}
