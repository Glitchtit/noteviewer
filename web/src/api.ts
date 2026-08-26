import type { NoteResponse, SearchResult, TreeNode } from '@noteviewer/shared';

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
};
