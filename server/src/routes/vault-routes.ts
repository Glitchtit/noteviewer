import type { FastifyInstance } from 'fastify';
import type { NoteResponse } from '@noteviewer/shared';
import fs from 'node:fs/promises';
import fastifyStatic from '@fastify/static';
import {
  buildTree,
  isHiddenName,
  readNote,
  trashNote,
  uniqueCopyPath,
  writeNoteAtomic,
} from '../vault/files.js';
import { resolveVaultPath, PathError } from '../vault/paths.js';
import { rewriteLinks } from '../vault/rename.js';
import path from 'node:path';

function relParam(params: unknown): string {
  const raw = (params as Record<string, string>)['*'] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // Defense-in-depth: Fastify pre-decodes paths; this catches double-encoded sequences like `foo%25ZZ.md`
    return '\u0000invalid';
  }
}

function badNotePath(rel: string): boolean {
  return rel.includes('\u0000') || rel.split('/').some(isHiddenName) || !rel.endsWith('.md');
}

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
      let rel = req.body.path;
      if (badNotePath(rel)) return reply.code(400).send({ error: 'bad path' });
      try {
        let exists = true;
        try {
          await fs.access(resolveVaultPath(app.vaultRoot, rel));
        } catch {
          exists = false;
        }
        if (exists) {
          if (!req.body.unique) return reply.code(409).send({ error: 'already exists' });
          rel = await uniqueCopyPath(app.vaultRoot, rel);
        }
        const result = await writeNoteAtomic(app.vaultRoot, rel, req.body.content ?? '');
        if (result.conflict) return reply.code(409).send({ error: 'already exists' });
        await app.index.updateNote(rel);
        app.bus.emitEvent({ type: 'tree-changed' });
        app.bus.emitEvent({ type: 'note-changed', path: rel });
        return reply.code(201).send({ path: rel, mtimeMs: result.mtimeMs, hash: result.hash });
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
      const trashedTo = await trashNote(app.vaultRoot, rel);
      app.index.removeNote(rel);
      app.bus.emitEvent({ type: 'tree-changed' });
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
        const fromAbs = resolveVaultPath(app.vaultRoot, from);
        const toAbs = resolveVaultPath(app.vaultRoot, to);
        try {
          await fs.access(toAbs);
          return reply.code(409).send({ error: 'target exists' });
        } catch {
          // target free
        }
        const referrers = app.index.backlinksOf(from);
        await fs.mkdir(path.dirname(toAbs), { recursive: true });
        await fs.rename(fromAbs, toAbs);
        const oldName = path.posix.basename(from, '.md');
        const newName = path.posix.basename(to, '.md');
        const fromPathNoExt = from.slice(0, -'.md'.length);
        const toPathNoExt = to.slice(0, -'.md'.length);
        const applyRewrites = (content: string): string => {
          let updated = rewriteLinks(content, oldName, newName);
          if (fromPathNoExt !== oldName) {
            updated = rewriteLinks(updated, fromPathNoExt, toPathNoExt);
          }
          return updated;
        };
        const rewritten: string[] = [];
        for (const ref of referrers) {
          let file = await readNote(app.vaultRoot, ref);
          const updated = applyRewrites(file.content);
          if (updated !== file.content) {
            let result = await writeNoteAtomic(app.vaultRoot, ref, updated, file.hash);
            if (result.conflict) {
              // Retry: re-read and attempt write with fresh hash
              file = await readNote(app.vaultRoot, ref);
              const retryUpdated = applyRewrites(file.content);
              if (retryUpdated !== file.content) {
                result = await writeNoteAtomic(app.vaultRoot, ref, retryUpdated, file.hash);
              }
            }
            // Only include in rewritten if write succeeded (no conflict)
            if (!result.conflict) {
              await app.index.updateNote(ref);
              rewritten.push(ref);
            }
          }
        }
        app.index.removeNote(from);
        await app.index.updateNote(to);
        app.bus.emitEvent({ type: 'tree-changed' });
        for (const ref of rewritten) app.bus.emitEvent({ type: 'note-changed', path: ref });
        return { rewritten };
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
