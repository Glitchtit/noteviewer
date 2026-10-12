import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { VaultIndex } from '../src/vault/indexer.js';
import { buildApp } from '../src/app.js';
import { makeVault } from './helpers.js';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

async function indexed(files: Record<string, string>) {
  const root = await makeVault(files);
  const index = new VaultIndex(root);
  await index.init();
  return { index, root };
}

describe('VaultIndex.addressBook', () => {
  it('lists every address with the notes it appears in, sorted by address', async () => {
    const { index } = await indexed({
      'Kontakter/Andreas Fagerström.md': '# Andreas Fagerström\n\nE-post: Andreas.fagerstrom@fcg.fi',
      'Projekt/FCG.md': '# FCG\n\nKontakt: [mail](mailto:andreas.fagerstrom@FCG.fi), support@fcg.fi',
      'Plain.md': 'no addresses here',
      '.trash/old.md': 'gone@x.fi',
    });
    expect(index.addressBook()).toEqual([
      {
        email: 'Andreas.fagerstrom@fcg.fi',
        notes: [
          { path: 'Kontakter/Andreas Fagerström.md', title: 'Andreas Fagerström' },
          { path: 'Projekt/FCG.md', title: 'FCG' },
        ],
      },
      { email: 'support@fcg.fi', notes: [{ path: 'Projekt/FCG.md', title: 'FCG' }] },
    ]);
  });

  it('follows note updates and deletions', async () => {
    const { index, root } = await indexed({ 'a.md': 'old@x.fi' });
    await writeFile(path.join(root, 'a.md'), 'new@x.fi');
    await index.updateNote('a.md');
    expect(index.addressBook().map((e) => e.email)).toEqual(['new@x.fi']);
    await rm(path.join(root, 'a.md'));
    index.removeNote('a.md');
    expect(index.addressBook()).toEqual([]);
  });
});

describe('GET /api/emails', () => {
  let app: FastifyInstance;
  afterEach(() => app?.close());

  it('returns the address book', async () => {
    app = await buildApp({ vaultRoot: await makeVault({ 'Card.md': '# Anna\nanna@x.fi' }) });
    const res = await app.inject({ url: '/api/emails' });
    expect(res.json()).toEqual([{ email: 'anna@x.fi', notes: [{ path: 'Card.md', title: 'Anna' }] }]);
  });
});
