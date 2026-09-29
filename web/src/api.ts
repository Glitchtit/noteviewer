import type { AiAction, AiStatus, GraphData, NoteResponse, SearchResult, TreeNode } from '@noteviewer/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

let networkErrorListener: (() => void) | null = null;

export function onNetworkError(fn: (() => void) | null): void {
  networkErrorListener = fn;
}

export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    networkErrorListener?.();
    throw new ApiError(0, 'network error', err);
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, `request failed: ${res.status}`, body);
  return body as T;
}

export const api = {
  tree: () => request<TreeNode>('/api/tree'),
  note: (path: string) => request<NoteResponse>(`/api/note/${encodePath(path)}`),
  save: (path: string, content: string, baseHash: string) =>
    request<{ mtimeMs: number; hash: string }>(`/api/note/${encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content, baseHash }),
    }),
  create: (path: string, content = '', unique = false) =>
    request<{ path: string; mtimeMs: number; hash: string }>('/api/note', {
      method: 'POST',
      body: JSON.stringify({ path, content, unique }),
    }),
  remove: (path: string) =>
    request<{ trashedTo: string }>(`/api/note/${encodePath(path)}`, { method: 'DELETE' }),
  rename: (from: string, to: string) =>
    request<{ rewritten: string[] }>('/api/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
  search: (q: string) => request<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),
  graph: () => request<GraphData>('/api/graph'),
  aiStatus: () => request<AiStatus>('/api/ai/status'),
};

export interface AiRequest {
  action: AiAction;
  path?: string;
  content?: string;
  selection?: string;
  prompt?: string;
  history?: { role: 'user' | 'model'; text: string }[];
}

/**
 * POST /api/ai and feed each streamed text delta to onText. Resolves when the
 * response ends; rejects with ApiError (message = server's error) on failure.
 * Aborting via `signal` rejects with the fetch AbortError.
 */
export async function streamAi(
  req: AiRequest,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new ApiError(res.status, body?.error ?? `request failed: ${res.status}`, body);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) onText(text);
  }
  const tail = decoder.decode();
  if (tail) onText(tail);
}
