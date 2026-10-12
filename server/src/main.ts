import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, buildPublicApp } from './app.js';
import { createPdfRenderer } from './share/pdf.js';
import { ShareStore } from './share/store.js';

const vaultRoot = path.resolve(process.env['VAULT_PATH'] ?? '/vault');
const port = Number(process.env['PORT'] ?? 8080);
// empty string disables the public share listener
const publicPort = process.env['PUBLIC_PORT'] === '' ? undefined : Number(process.env['PUBLIC_PORT'] ?? 8081);
const dataDir = path.resolve(process.env['DATA_PATH'] ?? './data');
const webDist = path.resolve(fileURLToPath(import.meta.url), '../../../web/dist');

if (!existsSync(vaultRoot)) {
  console.error(`VAULT_PATH does not exist: ${vaultRoot}`);
  process.exit(1);
}

const serveWeb = existsSync(webDist) ? webDist : undefined;
const shares = await ShareStore.open(dataDir);

const app = await buildApp({
  vaultRoot,
  watch: true,
  serveWeb,
  shares,
  // Chromium prints the private listener's /print page; it never goes through the public one
  pdf: createPdfRenderer(`http://127.0.0.1:${port}`),
  publicBaseUrl: process.env['PUBLIC_SHARE_URL'],
  ai: {
    apiKey: process.env['ANTHROPIC_API_KEY'],
    model: process.env['AI_MODEL'],
    effort: process.env['AI_EFFORT'],
    maxRounds: process.env['AI_MAX_ROUNDS'] ? Number(process.env['AI_MAX_ROUNDS']) : undefined,
    fallbacks: process.env['AI_FALLBACKS'] !== 'off',
    profileNote: process.env['AI_PROFILE_NOTE'],
    dataDir,
  },
});
const publicApp =
  publicPort === undefined
    ? undefined
    : await buildPublicApp({ vaultRoot, index: app.index, shares, serveWeb });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    void Promise.all([app.close(), publicApp?.close()]).then(() => process.exit(0));
  });
}

await app.listen({ port, host: '0.0.0.0' });
console.log(`noteviewer listening on :${port}, vault: ${vaultRoot}, data: ${dataDir}`);
if (publicApp) {
  await publicApp.listen({ port: publicPort, host: '0.0.0.0' });
  console.log(`public share listener on :${publicPort}`);
}
