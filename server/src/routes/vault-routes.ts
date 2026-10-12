import type { FastifyInstance } from 'fastify';
import type { NoteResponse } from '@noteviewer/shared';
import fastifyStatic from '@fastify/static';
import { buildTree, isHiddenName, readNote } from '../vault/files.js';
import { PathError } from '../vault/paths.js';
import { createNote, deleteNote, renameNote, writeNote } from '../vault/ops.js';
import { badNotePath, relParam } from './params.js';

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, { root: app.vaultRoot, serve: false });

  app.get('/api/tree', async () => buildTree(app.vaultRoot));

  app.get('/api/note/*', async (req, reply) => {
    const rel = relParam(req.params);
    if (badNotePath(rel)) return reply.code(404).send({ error: 'note not found' });
    try {
      const file = await readNote(app.vaultRoot, rel);
      await app.index.updateNote(rel);
      const meta = app.index.getMeta(rel)!;
      const body: NoteResponse = {
        meta,
        backlinks: app.index.backlinksOf(rel),
        content: file.content,
      };
      return body;
    } catch (err) {
      if (
        err instanceof PathError ||
        (err as NodeJS.ErrnoException).code === 'ENOENT' ||
        (err as NodeJS.ErrnoException).code === 'EISDIR'
      ) {
        return reply.code(404).send({ error: 'note not found' });
      }
      throw err;
    }
  });

  app.put<{ Body: { content: string; baseHash?: string } }>(
    '/api/note/*',
    {
      schema: {
        body: {
          type: 'object',
          required: ['content'],
          properties: { content: { type: 'string' }, baseHash: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const rel = relParam(req.params);
      if (badNotePath(rel)) return reply.code(404).send({ error: 'bad path' });
      try {
        const result = await writeNote(app, rel, req.body.content, req.body.baseHash);
        if (result.conflict) return reply.code(409).send({ current: result.current });
        return { mtimeMs: result.mtimeMs, hash: result.hash };
      } catch (err) {
        if (err instanceof PathError) return reply.code(404).send({ error: 'bad path' });
        throw err;
      }
    },
  );

  app.post<{ Body: { path: string; content?: string; unique?: boolean } }>(
    '/api/note',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            unique: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const rel = req.body.path;
      if (badNotePath(rel)) return reply.code(400).send({ error: 'bad path' });
      try {
        const created = await createNote(app, rel, req.body.content ?? '', req.body.unique ?? false);
        if (!created) return reply.code(409).send({ error: 'already exists' });
        return reply.code(201).send(created);
      } catch (err) {
        if (err instanceof PathError) return reply.code(400).send({ error: 'bad path' });
        throw err;
      }
    },
  );

  app.delete('/api/note/*', async (req, reply) => {
    const rel = relParam(req.params);
    if (badNotePath(rel)) return reply.code(404).send({ error: 'note not found' });
    try {
      const trashedTo = await deleteNote(app, rel);
      return { trashedTo };
    } catch (err) {
      if (err instanceof PathError || (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: 'note not found' });
      }
      throw err;
    }
  });

  app.post<{ Body: { from: string; to: string } }>(
    '/api/rename',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'to'],
          properties: { from: { type: 'string' }, to: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const { from, to } = req.body;
      if (badNotePath(from) || badNotePath(to)) return reply.code(400).send({ error: 'bad path' });
      try {
        const res = await renameNote(app, from, to);
        if (!res) return reply.code(409).send({ error: 'target exists' });
        return res;
      } catch (err) {
        if (err instanceof PathError || (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.code(404).send({ error: 'source not found' });
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) =>
    app.index.search(req.query.q ?? ''),
  );

  app.get('/api/graph', async () => app.index.graph());

  app.get('/api/file/*', async (req, reply) => {
    const rel = relParam(req.params);
    if (rel.includes('\u0000') || rel.split('/').some(isHiddenName)) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile(rel);
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write('retry: 3000\n\n');
    const off = app.bus.onEvent((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
}
