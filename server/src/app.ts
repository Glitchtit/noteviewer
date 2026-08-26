import Fastify, { type FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { VaultIndex } from './vault/indexer.js';
import { VaultBus, createChangeHandler, startWatcher } from './vault/watcher.js';
import { vaultRoutes } from './routes/vault-routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    vaultRoot: string;
    index: VaultIndex;
    bus: VaultBus;
  }
}

export interface AppOpts {
  vaultRoot: string;
  watch?: boolean;
  /** absolute path to web/dist; when set, serves the SPA with index.html fallback */
  serveWeb?: string;
}

export async function buildApp(opts: AppOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env['NODE_ENV'] === 'production' });
  const index = new VaultIndex(opts.vaultRoot);
  await index.init();
  const bus = new VaultBus();
  app.decorate('vaultRoot', opts.vaultRoot);
  app.decorate('index', index);
  app.decorate('bus', bus);
  await app.register(vaultRoutes);
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
