import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiEventsUrl, api, apiErrorMessage, ApiError, encodePath, onNetworkError } from '../src/api';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  fetchMock.mockReset();
  onNetworkError(null);
});

describe('api client', () => {
  it('encodes path segments but keeps slashes', () => {
    expect(encodePath('sub dir/no te.md')).toBe('sub%20dir/no%20te.md');
  });

  it('GETs a note from the right URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { content: 'x' }));
    await api.note('sub/a b.md');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/note/sub/a%20b.md');
  });

  it('PUTs saves with content and baseHash', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { mtimeMs: 1, hash: 'h2' }));
    const res = await api.save('a.md', 'new', 'h1');
    expect(res.hash).toBe('h2');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ content: 'new', baseHash: 'h1' });
  });

  it('sends DELETE without a JSON content-type (the server rejects an empty JSON body)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { trashedTo: '.trash/a.md' }));
    await api.remove('a.md');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('DELETE');
    expect(init.headers['content-type']).toBeUndefined();
  });

  it('throws ApiError with body on 409', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { current: { content: 'disk', mtimeMs: 2, hash: 'hd' } }),
    );
    const err = await api.save('a.md', 'mine', 'stale').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.body.current.content).toBe('disk');
  });

  it('throws ApiError status 0 and notifies listener on network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const listener = vi.fn();
    onNetworkError(listener);
    const err = await api.tree().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('creates with unique flag', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { path: 'n-copy.md', mtimeMs: 1, hash: 'h' }));
    const res = await api.create('n.md', 'body', true);
    expect(res.path).toBe('n-copy.md');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      path: 'n.md',
      content: 'body',
      unique: true,
    });
  });
});

describe('agent client', () => {
  it('starts a run with the prompt and context', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { turnId: 't1' }));
    const res = await api.aiRun('abc', { prompt: 'hi', path: 'a.md', selection: 'sel' });
    expect(res.turnId).toBe('t1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/sessions/abc/runs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ prompt: 'hi', path: 'a.md', selection: 'sel' });
  });

  it('posts undo requests with ids and a resolution', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [] }));
    await api.aiUndo('abc', 't1', { changeIds: ['c1'], resolution: 'copy' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/sessions/abc/turns/t1/undo');
    expect(JSON.parse(init.body)).toEqual({ changeIds: ['c1'], resolution: 'copy' });
  });

  it('creates, stops and deletes sessions', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'abc' }));
    expect((await api.aiCreateSession()).id).toBe('abc');
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST');
    fetchMock.mockResolvedValue(jsonResponse(200, { stopped: true }));
    await api.aiStop('abc');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/ai/sessions/abc/stop');
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await api.aiDeleteSession('abc');
    expect(fetchMock.mock.calls[2]![1].method).toBe('DELETE');
  });

  it('builds the events URL', () => {
    expect(aiEventsUrl('abc')).toBe('/api/ai/sessions/abc/events');
  });

  it("extracts the server's error message", () => {
    expect(apiErrorMessage(new ApiError(409, 'request failed: 409', { error: 'busy' }), 'fallback')).toBe('busy');
    expect(apiErrorMessage(new ApiError(500, 'x'), 'fallback')).toBe('fallback');
    expect(apiErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
