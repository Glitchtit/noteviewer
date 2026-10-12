import type {
  AiSession,
  AiSessionSummary,
  AiStatus,
  GraphData,
  NoteResponse,
  PublicNote,
  SearchResult,
  ShareWithUrl,
  TreeNode,
  UndoResolution,
  UndoResult,
} from '@noteviewer/shared';

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
      // Only label requests that carry a body: Fastify rejects an empty body
      // sent as application/json (which broke DELETE with a 400).
      headers: {
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
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
  aiSessions: () => request<AiSessionSummary[]>('/api/ai/sessions'),
  aiCreateSession: () => request<{ id: string }>('/api/ai/sessions', { method: 'POST' }),
  aiSession: (id: string) => request<AiSession>(`/api/ai/sessions/${encodeURIComponent(id)}`),
  aiDeleteSession: (id: string) =>
    request<void>(`/api/ai/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiRun: (id: string, body: { prompt: string; path?: string; selection?: string }) =>
    request<{ turnId: string }>(`/api/ai/sessions/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  aiStop: (id: string) =>
    request<{ stopped: boolean }>(`/api/ai/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  aiUndo: (id: string, turnId: string, body: { changeIds?: string[]; resolution?: UndoResolution }) =>
    request<{ results: UndoResult[] }>(
      `/api/ai/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}/undo`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  shares: (path: string) => request<ShareWithUrl[]>(`/api/shares?path=${encodeURIComponent(path)}`),
  createShare: (path: string, expiresInDays: number | null) =>
    request<ShareWithUrl>('/api/shares', {
      method: 'POST',
      body: JSON.stringify({ path, expiresInDays }),
    }),
  revokeShare: (token: string) =>
    request<{ revoked: boolean }>(`/api/shares/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  emailStatus: () => request<{ configured: boolean; from: string | null }>('/api/email/status'),
  email: (body: { path: string; to: string[]; subject: string; message: string }) =>
    request<{ sent: boolean }>('/api/email', { method: 'POST', body: JSON.stringify(body) }),
  publicNote: (token: string) => request<PublicNote>(`/api/public/${encodeURIComponent(token)}`),
  pdfUrl: (path: string) => `/api/pdf/${encodePath(path)}`,
};

/** URL of a session's SSE stream (snapshot, then live run events). */
export function aiEventsUrl(id: string): string {
  return `/api/ai/sessions/${encodeURIComponent(id)}/events`;
}

/** The server's `{ error }` message for an ApiError, else the fallback. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const msg = (err.body as { error?: unknown } | undefined)?.error;
    if (typeof msg === 'string' && msg) return msg;
  }
  return fallback;
}
