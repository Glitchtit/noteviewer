import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, encodePath, onNetworkError } from '../src/api';

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
