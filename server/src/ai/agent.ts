/**
 * The agent loop: stream a Claude turn, run the vault tools it asks for, send
 * the results back, repeat until it answers. History is append-only — every
 * assistant turn is stored exactly as returned (thinking, compaction and
 * fallback blocks included), which prompt caching and preserved thinking
 * both depend on.
 */

import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaToolResultBlockParam,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { ZERO_USAGE, addUsage, type AgentEvent, type AiUsage } from '@noteviewer/shared';
import { TOOL_DEFS, type VaultTools } from './tools.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentConfig {
  model: string;
  effort: Effort;
  /** maximum model requests per run */
  maxRounds: number;
  /** server-side refusal fallback (`fallbacks: "default"`) */
  fallbacks: boolean;
}

export interface AgentStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
}

/** The slice of the Anthropic client the loop uses (injectable for tests). */
export interface AgentClient {
  beta: { messages: { stream(params: never, opts?: { signal?: AbortSignal }): AgentStream } };
}

export type AgentEmit = (e: Exclude<AgentEvent, { type: 'snapshot' | 'turn_start' | 'turn_end' }>) => void;

export interface RunResult {
  status: 'done' | 'stopped' | 'error';
  error?: string;
}

const WEB_TOOLS: BetaToolUnion[] = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 },
];

const MAX_PARSE_RETRIES = 2;

export function buildParams(config: AgentConfig, system: string, messages: BetaMessageParam[]): object {
  return {
    model: config.model,
    max_tokens: 64000,
    system: [{ type: 'text', text: system }],
    messages,
    tools: [...TOOL_DEFS, ...WEB_TOOLS],
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: config.effort },
    cache_control: { type: 'ephemeral' },
    context_management: { edits: [{ type: 'compact_20260112' }] },
    betas: ['compact-2026-01-12', ...(config.fallbacks ? ['server-side-fallback-2026-07-01'] : [])],
    ...(config.fallbacks ? { fallbacks: 'default' } : {}),
  };
}

function apiErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid ANTHROPIC_API_KEY';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Claude API — try again shortly';
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: string } } | undefined;
    const detail = body?.error?.message ?? err.message;
    return err.status ? `Claude API error (${err.status}): ${detail}` : `Claude API error: ${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function usageOf(m: BetaMessage): AiUsage {
  return {
    inputTokens: m.usage?.input_tokens ?? 0,
    outputTokens: m.usage?.output_tokens ?? 0,
    cacheReadTokens: m.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: m.usage?.cache_creation_input_tokens ?? 0,
  };
}

/** UI rows for server-side tools (web search / fetch) found in a finished message. */
function emitServerTools(content: BetaContentBlock[], call: number, turnId: string, emit: AgentEmit): void {
  content.forEach((b, index) => {
    if (b.type !== 'server_tool_use') return;
    const input = (b.input ?? {}) as { query?: string; url?: string };
    const itemId = `${call}.${index}`;
    const result = content.find(
      (r) => (r.type === 'web_search_tool_result' || r.type === 'web_fetch_tool_result') && r.tool_use_id === b.id,
    ) as { content?: unknown } | undefined;
    const label = b.name === 'web_fetch' ? `web_fetch ${input.url ?? ''}` : `${b.name} "${input.query ?? ''}"`;
    const res = result?.content;
    const isError = !!res && !Array.isArray(res) && typeof res === 'object' && 'error_code' in res;
    const count = Array.isArray(res) ? ` (${res.length} results)` : '';
    emit({ type: 'tool_start', turnId, itemId, name: b.name, input: b.input });
    emit({
      type: 'tool_end',
      turnId,
      itemId,
      summary: `${label.trim()}${count}`,
      isError,
      detail: isError ? `Error: ${(res as { error_code: string }).error_code}` : undefined,
    });
  });
}

export async function runAgent(a: {
  client: AgentClient;
  config: AgentConfig;
  system: string;
  messages: BetaMessageParam[];
  tools: VaultTools;
  turnId: string;
  signal: AbortSignal;
  emit: AgentEmit;
}): Promise<RunResult> {
  const { client, config, system, messages, tools, turnId, signal, emit } = a;
  let usage: AiUsage = { ...ZERO_USAGE };
  let call = 0;
  let parseRetries = 0;

  for (;;) {
    if (signal.aborted) return { status: 'stopped' };
    if (call >= config.maxRounds) {
      return { status: 'error', error: `Stopped after ${config.maxRounds} model requests (round limit). Send a message to continue.` };
    }
    call++;

    let message: BetaMessage;
    try {
      const stream = client.beta.messages.stream(buildParams(config, system, messages) as never, { signal });
      for await (const ev of stream) {
        if (ev.type !== 'content_block_delta') continue;
        const itemId = `${call}.${ev.index}`;
        if (ev.delta.type === 'text_delta') emit({ type: 'text_delta', turnId, itemId, text: ev.delta.text });
        else if (ev.delta.type === 'thinking_delta') emit({ type: 'thinking_delta', turnId, itemId, text: ev.delta.thinking });
      }
      message = await stream.finalMessage();
      parseRetries = 0;
    } catch (err) {
      if (signal.aborted) return { status: 'stopped' };
      if (err instanceof Anthropic.APIError) return { status: 'error', error: apiErrorMessage(err) };
      // eager tool-input streaming: a tool input that isn't valid JSON fails
      // the whole turn; re-issue it (the failed turn was never appended)
      if (parseRetries++ < MAX_PARSE_RETRIES) continue;
      return { status: 'error', error: apiErrorMessage(err) };
    }

    usage = addUsage(usage, usageOf(message));
    emit({ type: 'usage', turnId, usage });
    emitServerTools(message.content, call, turnId, emit);

    const toolUses = message.content.filter((b) => b.type === 'tool_use');

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category;
      return { status: 'error', error: `Claude declined this request${category ? ` (${category})` : ''}.` };
    }
    if (message.stop_reason === 'max_tokens' && toolUses.length) {
      return { status: 'error', error: 'The response hit the output limit before a tool call was complete. Try a smaller request.' };
    }

    messages.push({ role: 'assistant', content: message.content as BetaMessageParam['content'] });

    if (message.stop_reason === 'pause_turn') continue;
    if (toolUses.length === 0) return { status: 'done' };

    // run tools one at a time: writes must not race each other
    const results: BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (signal.aborted) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Interrupted by the user', is_error: true });
        continue;
      }
      const itemId = `t:${tu.id}`;
      emit({ type: 'tool_start', turnId, itemId, name: tu.name, input: tu.input });
      const out = await tools.run(tu.name, tu.input);
      emit({ type: 'tool_end', turnId, itemId, summary: out.summary, detail: out.detail, isError: out.isError });
      if (out.change) emit({ type: 'change', turnId, record: { ...out.change, id: randomBytes(6).toString('base64url') } });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, is_error: out.isError });
    }
    messages.push({ role: 'user', content: results });
    if (signal.aborted) return { status: 'stopped' };
  }
}
