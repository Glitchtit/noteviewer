import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashContent } from '../src/vault/files.js';
import { makeVault } from './helpers.js';

let app: FastifyInstance;
afterEach(() => app?.close());

async function appFor(files: Record<string, string>) {
  const root = await makeVault(files);
  app = await buildApp({ vaultRoot: root });
  return { app, root };
}

describe('GET /api/tree', () => {
  it('returns the vault tree', async () => {
    const { app } = await appFor({ 'a.md': '', 'sub/b.md': '' });
    const res = await app.inject({ method: 'GET', url: '/api/tree' });
    expect(res.statusCode).toBe(200);
    expect(res.json().children.map((c: { path: string }) => c.path)).toEqual(['sub', 'a.md']);
  });
});

describe('GET /api/note/*', () => {
  it('returns content, meta, and backlinks', async () => {
    const { app } = await appFor({ 'a.md': 'links [[b]]', 'b.md': '# B' });
    const res = await app.inject({ method: 'GET', url: '/api/note/b.md' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('# B');
    expect(body.meta.title).toBe('B');
    expect(body.meta.hash).toBe(hashContent('# B'));
    expect(body.backlinks).toEqual(['a.md']);
  });

  it('404s on missing notes and path escapes', async () => {
    const { app } = await appFor({});
    expect((await app.inject({ url: '/api/note/nope.md' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/note/..%2Fescape.md' })).statusCode).toBe(404);
  });
});

describe('PUT /api/note/*', () => {
  it('saves when baseHash matches and reports the new hash', async () => {
    const { app, root } = await appFor({ 'a.md': 'v1' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/note/a.md',
      payload: { content: 'v2', baseHash: hashContent('v1') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hash).toBe(hashContent('v2'));
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('v2');
  });

  it('409s with disk content on stale baseHash', async () => {
    const { app, root } = await appFor({ 'a.md': 'disk' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/note/a.md',
      payload: { content: 'mine', baseHash: hashContent('other') },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().current.content).toBe('disk');
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('disk');
  });

  it('re-indexes after save so search/meta stay fresh', async () => {
    const { app } = await appFor({ 'a.md': '# Old' });
    await app.inject({
      method: 'PUT',
      url: '/api/note/a.md',
      payload: { content: '# Fresh', baseHash: hashContent('# Old') },
    });
    const res = await app.inject({ url: '/api/note/a.md' });
    expect(res.json().meta.title).toBe('Fresh');
  });
});
