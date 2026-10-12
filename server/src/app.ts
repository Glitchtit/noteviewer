import Fastify, { type FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { VaultIndex } from './vault/indexer.js';
import { VaultBus, createChangeHandler, startWatcher } from './vault/watcher.js';
import { vaultRoutes } from './routes/vault-routes.js';
import { aiRoutes, type AiOpts } from './routes/ai-routes.js';
import { shareRoutes } from './routes/share-routes.js';
import { publicRoutes } from './routes/public-routes.js';
import { ShareStore } from './share/store.js';
import { createMailer, type Mailer } from './share/mailer.js';
import type { PdfRenderer } from './share/pdf.js';

declare module 'fastify' {
  interface FastifyInstance {
    vaultRoot: string;
    index: VaultIndex;
    bus: VaultBus;
    shares: ShareStore;
    pdf: PdfRenderer | undefined;
    mailer: Mailer;
    /** origin of the public share listener, e.g. https://share.example.com ('' = same origin) */
    publicBaseUrl: string;
  }
}

export interface AppOpts {
  vaultRoot: string;
  watch?: boolean;
  /** absolute path to web/dist; when set, serves the SPA with index.html fallback */
  serveWeb?: string;
  /** Gemini integration; AI endpoints report disabled without an apiKey */
  ai?: AiOpts;
  /** defaults to an in-memory store */
  shares?: ShareStore;
  /** PDF renderer; PDF/email routes answer 503 without one */
  pdf?: PdfRenderer;
  /** defaults to a mailer built from SMTP_* env */
  mailer?: Mailer;
  publicBaseUrl?: string;
}

export async function buildApp(opts: AppOpts): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env['NODE_ENV'] === 'production',
    // SSE clients (`/api/events`) hold hijacked, in-flight connections open
    // indefinitely; without this, app.close() hangs waiting for them to end.
    forceCloseConnections: true,
  });
  const index = new VaultIndex(opts.vaultRoot);
  await index.init();
  const bus = new VaultBus();
  app.decorate('vaultRoot', opts.vaultRoot);
  app.decorate('index', index);
  app.decorate('bus', bus);
  app.decorate('shares', opts.shares ?? (await ShareStore.open()));
  app.decorate('pdf', opts.pdf);
  app.decorate('mailer', opts.mailer ?? createMailer());
  app.decorate('publicBaseUrl', (opts.publicBaseUrl ?? '').replace(/\/+$/, ''));
  await app.register(vaultRoutes);
  await app.register(aiRoutes, opts.ai ?? {});
  await app.register(shareRoutes);
  // also mounted here so a share link can be previewed on the private host
  await app.register(publicRoutes);
  if (opts.serveWeb) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, {
      root: opts.serveWeb,
      prefix: '/',
      decorateReply: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').send(
          // SPA fallback: any non-API route serves the app shell
          createReadStream(path.join(opts.serveWeb!, 'index.html')),
        );
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }
  if (opts.watch) {
    const watcher = startWatcher(opts.vaultRoot, createChangeHandler(index, bus, opts.vaultRoot));
    app.addHook('onClose', async () => {
      await watcher.close();
    });
  }
  return app;
}

export interface PublicAppOpts {
  vaultRoot: string;
  index: VaultIndex;
  shares: ShareStore;
  serveWeb?: string;
}

/**
 * The internet-facing listener (no Cloudflare Access in front of it). It
 * exposes only token-gated read-only routes plus the static SPA assets —
 * the tree, search, edit and event routes are never registered here.
 */
export async function buildPublicApp(opts: PublicAppOpts): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env['NODE_ENV'] === 'production',
    forceCloseConnections: true,
  });
  app.decorate('vaultRoot', opts.vaultRoot);
  app.decorate('index', opts.index);
  app.decorate('shares', opts.shares);
  await app.register(publicRoutes);
  if (opts.serveWeb) {
    const { default: fastifyStatic } = await import('@fastify/static');
    // only the hashed Vite bundle; index.html is handed out solely for /s/* below
    await app.register(fastifyStatic, {
      root: path.join(opts.serveWeb, 'assets'),
      prefix: '/assets/',
      index: false,
      decorateReply: false,
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (opts.serveWeb && req.method === 'GET' && /^\/s\/[A-Za-z0-9_-]+\/?$/.test(req.url)) {
      return reply
        .type('text/html')
        .header('x-robots-tag', 'noindex, nofollow')
        .header('referrer-policy', 'no-referrer')
        .send(createReadStream(path.join(opts.serveWeb, 'index.html')));
    }
    return reply.code(404).type('text/plain').send('Not found');
  });
  return app;
}
