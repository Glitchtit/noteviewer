import Fastify, { type FastifyInstance } from 'fastify';
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
  if (opts.watch) {
    const watcher = startWatcher(opts.vaultRoot, createChangeHandler(index, bus, opts.vaultRoot));
    app.addHook('onClose', async () => {
      await watcher.close();
    });
  }
  return app;
}
