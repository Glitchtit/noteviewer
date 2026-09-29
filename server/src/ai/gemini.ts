import type { ChatTurn } from './skill.js';

export interface GeminiOpts {
  apiKey: string;
  model: string;
  /** injectable for tests */
  fetch?: typeof fetch;
}

export class GeminiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

function textOf(chunk: GeminiChunk): string {
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
}

/**
 * Stream a completion from the Gemini API (`streamGenerateContent?alt=sse`),
 * yielding text deltas as they arrive.
 */
export async function* streamGemini(
  opts: GeminiOpts,
  system: string,
  contents: ChatTurn[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${BASE}/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: contents.map((c) => ({ role: c.role, parts: [{ text: c.text }] })),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `Gemini request failed (${res.status})`;
    try {
      const body = (await res.json()) as GeminiChunk;
      if (body.error?.message) message = body.error.message;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new GeminiError(res.status, message);
  }

  const decoder = new TextDecoder();
  let buf = '';
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; tolerate \r\n framing
      buf = buf.replace(/\r\n/g, '\n');
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const chunk = JSON.parse(data) as GeminiChunk;
        if (chunk.error) throw new GeminiError(500, chunk.error.message ?? 'Gemini error');
        if (chunk.promptFeedback?.blockReason) {
          throw new GeminiError(400, `Request blocked by Gemini (${chunk.promptFeedback.blockReason})`);
        }
        const text = textOf(chunk);
        if (text) yield text;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
