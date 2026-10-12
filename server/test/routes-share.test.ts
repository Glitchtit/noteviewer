import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildPublicApp } from '../src/app.js';
import type { Mailer } from '../src/share/mailer.js';
import { ShareStore } from '../src/share/store.js';
import { makeVault } from './helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function fakeMailer(configured = true): Mailer & { send: ReturnType<typeof vi.fn> } {
  return { configured, from: 'bot@example.com', send: vi.fn().mockResolvedValue(undefined) };
}

async function setup(files: Record<string, string>, opts: { mailer?: Mailer; pdf?: boolean } = {}) {
  const root = await makeVault(files);
  const shares = await ShareStore.open();
  const pdf = vi.fn(async (p: string) => Buffer.from(`%PDF-fake ${p}`));
  const app = await buildApp({
    vaultRoot: root,
    shares,
    pdf: opts.pdf === false ? undefined : pdf,
    mailer: opts.mailer ?? fakeMailer(),
    publicBaseUrl: 'https://share.example.com/',
  });
  const webDist = await mkdtemp(path.join(tmpdir(), 'noteviewer-dist-'));
  await writeFile(path.join(webDist, 'index.html'), '<!doctype html><div id="root"></div>');
  await mkdir(path.join(webDist, 'assets'));
  await writeFile(path.join(webDist, 'assets', 'app.js'), 'console.log(1)');
  const pub = await buildPublicApp({ vaultRoot: root, index: app.index, shares, serveWeb: webDist });
  apps.push(app, pub);
  return { app, pub, root, pdf };
}

async function share(app: FastifyInstance, p: string, expiresInDays: number | null = null) {
  const res = await app.inject({ method: 'POST', url: '/api/shares', payload: { path: p, expiresInDays } });
  expect(res.statusCode).toBe(201);
  return res.json() as { token: string; url: string; expiresAt: string | null };
}

describe('private share management', () => {
  it('creates, lists and revokes links with public URLs', async () => {
    const { app } = await setup({ 'a.md': '# A' });
    const s = await share(app, 'a.md', 7);
    expect(s.url).toBe(`https://share.example.com/s/${s.token}`);
    expect(s.expiresAt).not.toBeNull();
    const list = await app.inject({ method: 'GET', url: '/api/shares?path=a.md' });
    expect(list.json().map((x: { token: string }) => x.token)).toEqual([s.token]);
    const del = await app.inject({ method: 'DELETE', url: `/api/shares/${s.token}` });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/shares?path=a.md' })).json()).toEqual([]);
  });

  it('refuses to share missing or hidden notes', async () => {
    const { app } = await setup({ 'a.md': '' });
    for (const p of ['missing.md', '.obsidian/x.md', '../a.md', 'a.txt']) {
      const res = await app.inject({ method: 'POST', url: '/api/shares', payload: { path: p } });
      expect(res.statusCode, p).toBeGreaterThanOrEqual(400);
    }
  });

  it('links follow in-app renames and die with in-app deletes', async () => {
    const { app, pub } = await setup({ 'a.md': '# A', 'b.md': '# B' });
    const a = await share(app, 'a.md');
    const b = await share(app, 'b.md');
    await app.inject({ method: 'POST', url: '/api/rename', payload: { from: 'a.md', to: 'sub/c.md' } });
    expect((await pub.inject({ url: `/api/public/${a.token}` })).json().content).toBe('# A');
    await app.inject({ method: 'DELETE', url: '/api/note/b.md' });
    expect((await pub.inject({ url: `/api/public/${b.token}` })).statusCode).toBe(404);
  });
});

describe('GET /api/pdf/*', () => {
  it('returns the rendered PDF as a UTF-8-safe attachment', async () => {
    const { app, pdf } = await setup({ 'DIFF/Möte.md': '# Möte' });
    const res = await app.inject({ url: `/api/pdf/DIFF/${encodeURIComponent('Möte.md')}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''M%C3%B6te.pdf");
    expect(pdf).toHaveBeenCalledWith('DIFF/Möte.md');
  });

  it('404s unknown notes and 503s without a renderer', async () => {
    const { app } = await setup({ 'a.md': '' }, { pdf: false });
    expect((await app.inject({ url: '/api/pdf/missing.md' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/pdf/a.md' })).statusCode).toBe(503);
  });
});

describe('POST /api/email', () => {
  const body = { path: 'a.md', to: ['x@example.com'], subject: 'Agenda', message: 'Hej!' };

  it('sends the PDF with reply-to from Cloudflare Access', async () => {
    const mailer = fakeMailer();
    const { app } = await setup({ 'a.md': '# A' }, { mailer });
    const res = await app.inject({
      method: 'POST',
      url: '/api/email',
      payload: body,
      headers: { 'cf-access-authenticated-user-email': 'me@example.com' },
    });
    expect(res.statusCode).toBe(200);
    const msg = mailer.send.mock.calls[0]![0];
    expect(msg).toMatchObject({ to: ['x@example.com'], replyTo: 'me@example.com', subject: 'Agenda', text: 'Hej!' });
    expect(msg.attachment.filename).toBe('a.pdf');
    expect(msg.attachment.content.toString()).toBe('%PDF-fake a.md');
  });

  it('rejects bad recipients and reports unconfigured SMTP', async () => {
    const { app } = await setup({ 'a.md': '' }, { mailer: fakeMailer(false) });
    const bad = await app.inject({ method: 'POST', url: '/api/email', payload: { ...body, to: ['nope'] } });
    expect(bad.statusCode).toBe(400);
    const off = await app.inject({ method: 'POST', url: '/api/email', payload: body });
    expect(off.statusCode).toBe(503);
    expect((await app.inject({ url: '/api/email/status' })).json()).toEqual({ configured: false, from: 'bot@example.com' });
  });

  it('surfaces SMTP failures as 502', async () => {
    const mailer = fakeMailer();
    mailer.send.mockRejectedValue(new Error('auth failed'));
    const { app } = await setup({ 'a.md': '' }, { mailer });
    const res = await app.inject({ method: 'POST', url: '/api/email', payload: body });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('auth failed');
  });
});

describe('public listener', () => {
  it('serves a shared note and the SPA shell, with noindex headers', async () => {
    const { app, pub } = await setup({ 'a.md': '---\ntags: [x]\n---\n# Title A\n\nBody' });
    const s = await share(app, 'a.md');
    const res = await pub.inject({ url: `/api/public/${s.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ title: 'Title A', content: '---\ntags: [x]\n---\n# Title A\n\nBody' });
    expect(res.headers['x-robots-tag']).toContain('noindex');
    const shell = await pub.inject({ url: `/s/${s.token}` });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain('id="root"');
    expect((await pub.inject({ url: '/assets/app.js' })).statusCode).toBe(200);
  });

  it('exposes none of the private API or the app at /', async () => {
    const { pub } = await setup({ 'a.md': '# A' });
    for (const [method, url] of [
      ['GET', '/'],
      ['GET', '/index.html'],
      ['GET', '/assets/../index.html'],
      ['GET', '/print?path=a.md'],
      ['GET', '/api/tree'],
      ['GET', '/api/note/a.md'],
      ['GET', '/api/search?q=a'],
      ['GET', '/api/events'],
      ['GET', '/api/file/a.md'],
      ['GET', '/api/shares?path=a.md'],
      ['GET', '/api/pdf/a.md'],
      ['POST', '/api/shares'],
      ['POST', '/api/email'],
      ['PUT', '/api/note/a.md'],
      ['DELETE', '/api/note/a.md'],
    ] as const) {
      const res = await pub.inject({ method, url, payload: method === 'GET' || method === 'DELETE' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('404s unknown, revoked and expired tokens', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-01T00:00:00Z'), toFake: ['Date'] });
    try {
      const { app, pub } = await setup({ 'a.md': '# A' });
      expect((await pub.inject({ url: '/api/public/nope' })).statusCode).toBe(404);
      const revoked = await share(app, 'a.md');
      await app.inject({ method: 'DELETE', url: `/api/shares/${revoked.token}` });
      expect((await pub.inject({ url: `/api/public/${revoked.token}` })).statusCode).toBe(404);
      const week = await share(app, 'a.md', 7);
      expect((await pub.inject({ url: `/api/public/${week.token}` })).statusCode).toBe(200);
      vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
      expect((await pub.inject({ url: `/api/public/${week.token}` })).statusCode).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves only files the shared note embeds, never notes', async () => {
    const { app, pub } = await setup({
      'a.md': '# A\n\n![[pic.png]]\n![[Secret]]',
      'img/pic.png': 'PNGDATA',
      'other.png': 'OTHER',
      'Secret.md': 'top secret',
    });
    const s = await share(app, 'a.md');
    const ok = await pub.inject({ url: `/api/public/${s.token}/embed/pic.png` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('PNGDATA');
    expect((await pub.inject({ url: `/api/public/${s.token}/embed/other.png` })).statusCode).toBe(404);
    expect((await pub.inject({ url: `/api/public/${s.token}/embed/Secret` })).statusCode).toBe(404);
    expect((await pub.inject({ url: `/api/public/${s.token}/embed/..%2Fa.md` })).statusCode).toBe(404);
  });
});
