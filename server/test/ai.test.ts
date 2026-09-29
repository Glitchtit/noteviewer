import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { buildContents, buildSystemPrompt } from '../src/ai/skill.js';
import { makeVault } from './helpers.js';

let app: FastifyInstance;
afterEach(() => app?.close());

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const text = (t: string) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });

async function appFor(files: Record<string, string>, fetchImpl?: typeof fetch, apiKey = 'k') {
  const root = await makeVault(files);
  app = await buildApp({ vaultRoot: root, ai: { apiKey, model: 'test-model', fetch: fetchImpl } });
  return app;
}

describe('skill prompts', () => {
  it('folds the profile note into the system prompt', () => {
    expect(buildSystemPrompt({})).not.toContain('user_profile');
    expect(buildSystemPrompt({ profile: 'I teach electricians.' })).toContain('I teach electricians.');
  });

  it('prepends vault context to the first user turn only', () => {
    const contents = buildContents({
      action: 'ask',
      content: 'note body',
      prompt: 'and then?',
      history: [
        { role: 'user', text: 'first q' },
        { role: 'model', text: 'first a' },
      ],
    });
    expect(contents).toHaveLength(3);
    expect(contents[0]!.text).toContain('note body');
    expect(contents[0]!.text).toContain('first q');
    expect(contents[2]).toEqual({ role: 'user', text: 'and then?' });
  });
});

describe('GET /api/ai/status', () => {
  it('reports disabled without an api key', async () => {
    await appFor({}, undefined, '');
    const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
    expect(res.json()).toMatchObject({ enabled: false, profileNote: 'AI Profile.md', profileExists: false });
  });

  it('reports the profile note', async () => {
    await appFor({ 'AI Profile.md': 'me' });
    const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
    expect(res.json()).toMatchObject({ enabled: true, model: 'test-model', profileExists: true });
  });
});

describe('POST /api/ai', () => {
  it('503s when not configured', async () => {
    await appFor({}, undefined, '');
    const res = await app.inject({ method: 'POST', url: '/api/ai', payload: { action: 'summarize', content: 'x' } });
    expect(res.statusCode).toBe(503);
  });

  it('streams Gemini text and sends vault context, profile and key', async () => {
    const fetchMock = vi.fn(async () => sse([text('Hello '), text('world'), { candidates: [{ finishReason: 'STOP' }] }]));
    await appFor(
      { 'AI Profile.md': 'Answer in Swedish.', 'Other.md': '#kurs/el', 'a.md': 'body' },
      fetchMock as unknown as typeof fetch,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai',
      payload: { action: 'summarize', path: 'a.md', content: 'unsaved body' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('Hello world');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/test-model:streamGenerateContent?alt=sse');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    const sent = JSON.parse(init.body as string);
    expect(sent.systemInstruction.parts[0].text).toContain('Answer in Swedish.');
    const turn = sent.contents[0].parts[0].text as string;
    expect(turn).toContain('unsaved body');
    expect(turn).toContain('Other');
    expect(turn).toContain('#kurs/el');
  });

  it('retrieves related notes for ask-vault', async () => {
    const fetchMock = vi.fn(async () => sse([text('ok')]));
    await appFor(
      { 'Pumps.md': 'Centrifugal pumps need priming.', 'Cats.md': 'meow' },
      fetchMock as unknown as typeof fetch,
    );
    await app.inject({ method: 'POST', url: '/api/ai', payload: { action: 'ask-vault', prompt: 'priming pumps' } });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const turn = sent.contents[0].parts[0].text as string;
    expect(turn).toContain('Centrifugal pumps need priming.');
    expect(turn).not.toContain('meow');
  });

  it('maps upstream failures to an error status', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }),
    );
    await appFor({}, fetchMock as unknown as typeof fetch);
    const res = await app.inject({ method: 'POST', url: '/api/ai', payload: { action: 'summarize', content: 'x' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('API key not valid');
  });

  it('rejects bad actions, paths, and empty questions', async () => {
    await appFor({}, vi.fn() as unknown as typeof fetch);
    const bad = [
      { action: 'nope' },
      { action: 'summarize', path: '../x.md' },
      { action: 'ask', prompt: '  ' },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/ai', payload });
      expect(res.statusCode).toBe(400);
    }
  });
});
