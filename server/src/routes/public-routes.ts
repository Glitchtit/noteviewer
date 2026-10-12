import type { FastifyInstance } from 'fastify';
import type { PublicNote } from '@noteviewer/shared';
import { resolveLink } from '@noteviewer/shared';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { buildTree, isHiddenName, readNote } from '../vault/files.js';

const EMBED = /!\[\[([^\]|#\n]+)/g;

function embedTargets(content: string): Set<string> {
  return new Set([...content.matchAll(EMBED)].map((m) => m[1]!.trim()));
}

/**
 * Token-gated read-only routes. These are the ONLY vault routes the public
 * listener exposes, so everything here must be scoped to the one shared note.
 */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, { root: app.vaultRoot, serve: false });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('referrer-policy', 'no-referrer');
  });

  async function sharedContent(token: string): Promise<{ path: string; content: string } | undefined> {
    const share = app.shares.get(token);
    if (!share) return undefined;
    try {
      const file = await readNote(app.vaultRoot, share.path);
      return { path: share.path, content: file.content };
    } catch {
      return undefined; // note deleted or moved outside noteviewer
    }
  }

  app.get<{ Params: { token: string } }>('/api/public/:token', async (req, reply) => {
    const note = await sharedContent(req.params.token);
    if (!note) return reply.code(404).send({ error: 'not found' });
    const body: PublicNote = {
      title: app.index.getMeta(note.path)?.title ?? path.posix.basename(note.path, '.md'),
      content: note.content,
    };
    return body;
  });

  // Only files the shared note itself embeds (`![[target]]`) are reachable.
  app.get<{ Params: { token: string; target: string } }>(
    '/api/public/:token/embed/:target',
    async (req, reply) => {
      const note = await sharedContent(req.params.token);
      const target = req.params.target;
      if (!note || !embedTargets(note.content).has(target)) {
        return reply.code(404).send({ error: 'not found' });
      }
      const resolved = resolveLink(await buildTree(app.vaultRoot), target);
      // notes are never served raw: `![[Other note]]` must not leak an unshared note
      if (!resolved || resolved.endsWith('.md') || resolved.split('/').some(isHiddenName)) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile(resolved);
    },
  );
}
