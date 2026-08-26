import type { FastifyInstance } from 'fastify';
import type { NoteResponse } from '@noteviewer/shared';
import { buildTree, readNote, writeNoteAtomic } from '../vault/files.js';
import { PathError } from '../vault/paths.js';

function relParam(params: unknown): string {
  return decodeURIComponent((params as Record<string, string>)['*'] ?? '');
}

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tree', async () => buildTree(app.vaultRoot));

  app.get('/api/note/*', async (req, reply) => {
    const rel = relParam(req.params);
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
      if (err instanceof PathError || (err as NodeJS.ErrnoException).code === 'ENOENT') {
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
      try {
        const result = await writeNoteAtomic(
          app.vaultRoot,
          rel,
          req.body.content,
          req.body.baseHash,
        );
        if (result.conflict) return reply.code(409).send({ current: result.current });
        await app.index.updateNote(rel);
        app.bus.emitEvent({ type: 'note-changed', path: rel });
        return { mtimeMs: result.mtimeMs, hash: result.hash };
      } catch (err) {
        if (err instanceof PathError) return reply.code(404).send({ error: 'bad path' });
        throw err;
      }
    },
  );
}
