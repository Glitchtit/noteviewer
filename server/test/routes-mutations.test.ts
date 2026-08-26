import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { makeVault } from './helpers.js';

let app: FastifyInstance;
afterEach(() => app?.close());

async function appFor(files: Record<string, string>) {
  const root = await makeVault(files);
  app = await buildApp({ vaultRoot: root });
  return { app, root };
}

describe('POST /api/note', () => {
  it('creates a note', async () => {
    const { app, root } = await appFor({});
    const res = await app.inject({
      method: 'POST',
      url: '/api/note',
      payload: { path: 'new.md', content: '# New' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe('new.md');
    expect(await readFile(path.join(root, 'new.md'), 'utf8')).toBe('# New');
  });

  it('409s on existing path, saves-as-copy with unique flag', async () => {
    const { app, root } = await appFor({ 'n.md': 'original' });
    const clash = await app.inject({
      method: 'POST',
      url: '/api/note',
      payload: { path: 'n.md', content: 'mine' },
    });
    expect(clash.statusCode).toBe(409);
    const copy = await app.inject({
      method: 'POST',
      url: '/api/note',
      payload: { path: 'n.md', content: 'mine', unique: true },
    });
    expect(copy.statusCode).toBe(201);
    expect(copy.json().path).toBe('n-copy.md');
    expect(await readFile(path.join(root, 'n-copy.md'), 'utf8')).toBe('mine');
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('original');
  });

  it('400s creating a note under a hidden directory', async () => {
    const { app } = await appFor({});
    const res = await app.inject({
      method: 'POST',
      url: '/api/note',
      payload: { path: '.trash/y.md', content: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/note/*', () => {
  it('moves to .trash and de-indexes', async () => {
    const { app, root } = await appFor({ 'a.md': 'bye' });
    const res = await app.inject({ method: 'DELETE', url: '/api/note/a.md' });
    expect(res.statusCode).toBe(200);
    expect(res.json().trashedTo).toBe('.trash/a.md');
    expect(await readFile(path.join(root, '.trash/a.md'), 'utf8')).toBe('bye');
    expect((await app.inject({ url: '/api/note/a.md' })).statusCode).toBe(404);
  });

  it('404s deleting a hidden-directory path', async () => {
    const { app } = await appFor({ '.trash/x.md': 'already trashed' });
    const res = await app.inject({ method: 'DELETE', url: '/api/note/.trash/x.md' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/rename', () => {
  it('moves the note and rewrites referring wikilinks', async () => {
    const { app, root } = await appFor({
      'Old.md': '# Old',
      'ref.md': 'see [[Old]] and [[Old|alias]]',
      'unrelated.md': '[[Older]] stays',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rename',
      payload: { from: 'Old.md', to: 'sub/New.md' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rewritten).toEqual(['ref.md']);
    expect(await readFile(path.join(root, 'sub/New.md'), 'utf8')).toBe('# Old');
    expect(await readFile(path.join(root, 'ref.md'), 'utf8')).toBe(
      'see [[New]] and [[New|alias]]',
    );
    expect(await readFile(path.join(root, 'unrelated.md'), 'utf8')).toBe('[[Older]] stays');
  });

  it('rewritten list matches actual disk state (honest reporting)', async () => {
    const { app, root } = await appFor({
      'Old.md': '# Old',
      'ref1.md': 'sees [[Old]]',
      'ref2.md': 'no link here',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rename',
      payload: { from: 'Old.md', to: 'New.md' },
    });
    expect(res.statusCode).toBe(200);
    const rewritten = res.json().rewritten;

    // rewritten should only contain ref1.md (which had the link)
    expect(rewritten).toEqual(['ref1.md']);

    // Verify disk state matches response:
    // ref1.md should have New instead of Old
    expect(await readFile(path.join(root, 'ref1.md'), 'utf8')).toBe('sees [[New]]');
    // ref2.md should be unchanged (not in rewritten)
    expect(await readFile(path.join(root, 'ref2.md'), 'utf8')).toBe('no link here');
    // Old.md should be moved
    expect(await readFile(path.join(root, 'New.md'), 'utf8')).toBe('# Old');
  });

  it('409s when the target exists', async () => {
    const { app } = await appFor({ 'a.md': '', 'b.md': '' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rename',
      payload: { from: 'a.md', to: 'b.md' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('400s renaming to or from a hidden-directory path', async () => {
    const { app } = await appFor({ 'a.md': '' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rename',
      payload: { from: 'a.md', to: '.trash/a.md' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rewrites path-qualified wikilinks on rename', async () => {
    const { app, root } = await appFor({
      'sub/Old.md': '# Old',
      'ref.md': 'see [[sub/Old]] and [[sub/Old|alias]]',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rename',
      payload: { from: 'sub/Old.md', to: 'sub2/New.md' },
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(path.join(root, 'ref.md'), 'utf8')).toBe(
      'see [[sub2/New]] and [[sub2/New|alias]]',
    );
  });
});

describe('GET /api/search', () => {
  it('searches indexed notes', async () => {
    const { app } = await appFor({ 'a.md': 'quantum flux capacitor' });
    const res = await app.inject({ url: '/api/search?q=quantum' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: { path: string }) => r.path)).toEqual(['a.md']);
  });
});

describe('GET /api/file/*', () => {
  it('serves attachments and hides dotpaths', async () => {
    const { app } = await appFor({ 'img.svg': '<svg/>', '.obsidian/app.json': '{}' });
    const ok = await app.inject({ url: '/api/file/img.svg' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('<svg/>');
    expect((await app.inject({ url: '/api/file/.obsidian/app.json' })).statusCode).toBe(404);
  });

  it('serves attachments whose path contains spaces', async () => {
    const { app } = await appFor({ 'img dir/pic name.svg': '<svg/>' });
    const res = await app.inject({ url: '/api/file/' + encodeURIComponent('img dir/pic name.svg').replace(/%2F/g, '/') });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<svg/>');
  });
});

describe('GET /api/events', () => {
  it('streams bus events as SSE', async () => {
    const { app } = await appFor({});
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    app.bus.emitEvent({ type: 'note-changed', path: 'x.md' });
    // accumulate chunks: the first read may only contain the `retry:` preamble
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('"note-changed"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('"note-changed"');
    expect(text).toContain('x.md');
    await reader.cancel();
  });
});
