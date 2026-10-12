/**
 * A scripted stand-in for the Anthropic client's `beta.messages.stream()`.
 * Each call consumes the next script entry and replays it as stream events.
 */

import type { AgentClient, AgentStream } from '../src/ai/agent.js';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'server_tool_use'; id: string; name: string; input: unknown }
  | { type: 'web_search_tool_result'; tool_use_id: string; content: unknown };

export interface FakeMessage {
  content: Block[];
  stop_reason: string;
  usage?: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>;
}

export interface ScriptEntry {
  message: FakeMessage;
  /** awaited after the first content block has streamed */
  wait?: Promise<void>;
}

export type Script = Array<FakeMessage | ScriptEntry | Error>;

export function msg(content: Block[], stop_reason = 'end_turn'): FakeMessage {
  return { content, stop_reason };
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function fullMessage(m: FakeMessage) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: m.content,
    stop_reason: m.stop_reason,
    stop_sequence: null,
    stop_details: m.stop_reason === 'refusal' ? { type: 'refusal', category: 'cyber', explanation: null } : null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...m.usage,
    },
  };
}

export function fakeClient(script: Script) {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const client: AgentClient = {
    beta: {
      messages: {
        stream(params: object, opts?: { signal?: AbortSignal }): AgentStream {
          calls.push(structuredClone(params) as Record<string, unknown>);
          const next = script[i++];
          const signal = opts?.signal;
          const abortError = () => Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
          if (!next) throw new Error(`fake client: no script entry for call ${i}`);
          const entry: FakeMessage | ScriptEntry | Error = next;
          let final: Promise<unknown>;
          let resolveFinal!: (v: unknown) => void;
          let rejectFinal!: (e: unknown) => void;
          final = new Promise((res, rej) => {
            resolveFinal = res;
            rejectFinal = rej;
          });
          final.catch(() => {});
          async function* events() {
            try {
              if (entry instanceof Error) throw entry;
              const { message, wait } = 'message' in entry ? entry : { message: entry, wait: undefined };
              yield { type: 'message_start', message: { ...fullMessage(message), content: [] } };
              for (const [index, b] of message.content.entries()) {
                if (signal?.aborted) throw abortError();
                const empty =
                  b.type === 'text' ? { type: 'text', text: '' } : b.type === 'thinking' ? { type: 'thinking', thinking: '' } : { ...b, input: {} };
                yield { type: 'content_block_start', index, content_block: empty };
                if (b.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } };
                if (b.type === 'thinking') yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } };
                if (b.type === 'tool_use') {
                  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } };
                }
                yield { type: 'content_block_stop', index };
                if (index === 0 && wait) {
                  await Promise.race([
                    wait,
                    new Promise((_, rej) => signal?.addEventListener('abort', () => rej(abortError()), { once: true })),
                  ]);
                }
              }
              if (signal?.aborted) throw abortError();
              yield { type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 5 } };
              yield { type: 'message_stop' };
              resolveFinal(fullMessage(message));
            } catch (err) {
              rejectFinal(err);
              throw err;
            }
          }
          const it = events();
          return {
            [Symbol.asyncIterator]: () => it,
            finalMessage: async () => {
              // drain if the caller didn't iterate
              for await (const _ of it) void _;
              return final as never;
            },
          } as AgentStream;
        },
      },
    },
  };
  return { client, calls };
}
