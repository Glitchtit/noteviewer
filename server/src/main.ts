import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const vaultRoot = path.resolve(process.env['VAULT_PATH'] ?? '/vault');
const port = Number(process.env['PORT'] ?? 8080);
const webDist = path.resolve(fileURLToPath(import.meta.url), '../../../web/dist');

if (!existsSync(vaultRoot)) {
  console.error(`VAULT_PATH does not exist: ${vaultRoot}`);
  process.exit(1);
}

const app = await buildApp({
  vaultRoot,
  watch: true,
  serveWeb: existsSync(webDist) ? webDist : undefined,
});

await app.listen({ port, host: '0.0.0.0' });
console.log(`noteviewer listening on :${port}, vault: ${vaultRoot}`);
