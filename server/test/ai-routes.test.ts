import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiSession } from '@noteviewer/shared';
import { buildApp, buildPublicApp } from '../src/app.js';
import { deferred, fakeClient, msg, type Script } from './fake-anthropic.js';
import { makeVault } from './helpers.js';

let app: FastifyInstance;
afterEach(() => app?.close());

async function appFor(files: Record<string, string>, script: Script = [], apiKey = 'k') {
  const root = await makeVault(files);
  const { client, calls } = fakeClient(script);
  app = await buildApp({ vaultRoot: root, ai: { apiKey, model: 'claude-opus-5-5', client } });
  return { root, calls };
}

async function newSession(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/ai/sessions' });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function waitDone(id: string): Promise<AiSession> {
  for (let i = 0; i < 200; i++) {
    const s = (await app.inject({ url: `/api/ai/sessions/${id}` })).json() as AiSession;
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('run did not finish');
}

describe('GET /api/ai/status', () => {
  it('reports disabled without an api key', async () => {
    await appFor({}, [], '');
    const res = await app.inject({ url: '/api/ai/status' });
    expect(res.json()).toEqual({
      enabled: false,
      model: 'claude-opus-5-5',
      profileNote: 'AI Profile.md',
      profileExists: false,
      claudeMdExists: false,
    });
  });

  it('reports the profile note and CLAUDE.md', async () => {
    await appFor({ 'AI Profile.md': 'me', 'CLAUDE.md': 'rules' });
    expect((await app.inject({ url: '/api/ai/status' })).json()).toMatchObject({ enabled: true, profileExists: true, claudeMdExists: true });
  });
});

describe('sessions', () => {
  it('creates, lists, gets and deletes sessions', async () => {
    await appFor({});
    const id = await newSession();
    const list = (await app.inject({ url: '/api/ai/sessions' })).json();
    expect(list).toEqual([{ id, title: 'New session', updatedAt: expect.any(String), running: false }]);
    expect((await app.inject({ url: `/api/ai/sessions/${id}` })).json()).toMatchObject({ id, turns: [], running: false });
    expect((await app.inject({ method: 'DELETE', url: `/api/ai/sessions/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/ai/sessions/${id}` })).statusCode).toBe(404);
  });

  it('freezes CLAUDE.md and the profile into the system prompt at creation', async () => {
    const { calls, root } = await appFor({ 'CLAUDE.md': 'Use Swedish.', 'AI Profile.md': 'I teach.' }, [msg([{ type: 'text', text: 'ok' }])]);
    const id = await newSession();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, 'CLAUDE.md'), 'Changed later.');
    await app.inject({ method: 'POST', url: `/api/ai/sessions/${id}/runs`, payload: { prompt: 'hi' } });
    await waitDone(id);
    const system = JSON.stringify(calls[0]!.system);
    expect(system).toContain('Use Swedish.');
    expect(system).toContain('I teach.');
    expect(system).not.toContain('Changed later.');
  });

  it('404s unknown and malformed session ids', async () => {
    await appFor({});
    expect((await app.inject({ url: '/api/ai/sessions/AAAAAAAAAAAAAAAA' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/ai/sessions/..%2F..%2Fx' })).statusCode).toBe(404);
  });
});

describe('runs', () => {
  it('runs the agent and records the turn', async () => {
    const { root } = await appFor(
      { 'a.md': 'old' },
      [
        msg([{ type: 'tool_use', id: 'r', name: 'read', input: { path: 'a.md' } }], 'tool_use'),
        msg([{ type: 'tool_use', id: 'e', name: 'edit', input: { path: 'a.md', old_string: 'old', new_string: 'new' } }], 'tool_use'),
        msg([{ type: 'text', text: 'Updated [[a]].' }]),
      ],
    );
    const id = await newSession();
    const res = await app.inject({
      method: 'POST',
      url: `/api/ai/sessions/${id}/runs`,
      payload: { prompt: 'update it', path: 'a.md', selection: 'old' },
    });
    expect(res.statusCode).toBe(202);
    const s = await waitDone(id);
    expect(s.turns[0]).toMatchObject({ status: 'done', context: { path: 'a.md', selection: 'old' } });
    expect(s.turns[0]!.items.at(-1)).toMatchObject({ kind: 'text', text: 'Updated [[a]].' });
    expect(s.turns[0]!.changes).toHaveLength(1);
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('new');

    const undo = await app.inject({
      method: 'POST',
      url: `/api/ai/sessions/${id}/turns/${s.turns[0]!.id}/undo`,
      payload: {},
    });
    expect(undo.json()).toEqual({ results: [{ id: s.turns[0]!.changes[0]!.id, status: 'undone' }] });
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('old');
  });

  it('validates the run request', async () => {
    await appFor({});
    const id = await newSession();
    const post = (payload: object) => app.inject({ method: 'POST', url: `/api/ai/sessions/${id}/runs`, payload });
    expect((await post({ prompt: '   ' })).statusCode).toBe(400);
    expect((await post({ prompt: 'x', path: '../x.md' })).statusCode).toBe(400);
    expect((await post({ prompt: 'x', path: '.obsidian/x.md' })).statusCode).toBe(400);
  });

  it('503s without an api key', async () => {
    await appFor({}, [], '');
    const id = await newSession();
    expect((await app.inject({ method: 'POST', url: `/api/ai/sessions/${id}/runs`, payload: { prompt: 'x' } })).statusCode).toBe(503);
  });

  it('409s a concurrent run, delete or undo, and stops on request', async () => {
    const gate = deferred();
    await appFor({}, [{ message: msg([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), wait: gate.promise }]);
    const id = await newSession();
    const run = await app.inject({ method: 'POST', url: `/api/ai/sessions/${id}/runs`, payload: { prompt: 'x' } });
    const turnId = run.json().turnId as string;
    expect((await app.inject({ method: 'POST', url: `/api/ai/sessions/${id}/runs`, payload: { prompt: 'y' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/ai/sessions/${id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/ai/sessions/${id}/turns/${turnId}/undo`, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/ai/sessions/${id}/stop` })).statusCode).toBe(200);
    expect((await waitDone(id)).turns[0]!.status).toBe('stopped');
  });

  it('streams a snapshot and live events over SSE', async () => {
    const gate = deferred();
    await appFor({}, [{ message: msg([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]), wait: gate.promise }]);
    const id = await newSession();
    await app.inject({ method: 'POST', url: `/api/ai/sessions/${id}/runs`, payload: { prompt: 'x' } });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${id}/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"snapshot"')) text += decoder.decode((await reader.read()).value, { stream: true });
    gate.resolve();
    while (!text.includes('"turn_end"')) text += decoder.decode((await reader.read()).value, { stream: true });
    expect(text).toContain('"text_delta"');
    expect(text).toContain('second');
    await reader.cancel();
  });
});

describe('public listener', () => {
  it('has no AI routes', async () => {
    const { root } = await appFor({});
    const pub = await buildPublicApp({ vaultRoot: root, index: app.index, shares: app.shares });
    expect((await pub.inject({ url: '/api/ai/status' })).statusCode).toBe(404);
    expect((await pub.inject({ method: 'POST', url: '/api/ai/sessions' })).statusCode).toBe(404);
    await pub.close();
  });
});
