import { describe, expect, it } from 'vitest';
import { AI_EFFORTS, AI_MODELS, estimateCost, foldEvent, QUICK_PROMPTS, ZERO_USAGE, addUsage, type AiTurn, type ChangeRecord } from '@noteviewer/shared';

function turn(id = 't1'): AiTurn {
  return { id, prompt: 'hi', context: {}, items: [], changes: [], status: 'running', startedAt: '2026-10-12T00:00:00Z' };
}

describe('foldEvent', () => {
  it('appends a turn on turn_start', () => {
    const turns = foldEvent([], { type: 'turn_start', turn: turn() });
    expect(turns.map((t) => t.id)).toEqual(['t1']);
  });

  it('creates a text item on the first delta and appends to it afterwards', () => {
    let turns = [turn()];
    turns = foldEvent(turns, { type: 'text_delta', turnId: 't1', itemId: 'a', text: 'Hel' });
    turns = foldEvent(turns, { type: 'text_delta', turnId: 't1', itemId: 'a', text: 'lo' });
    turns = foldEvent(turns, { type: 'thinking_delta', turnId: 't1', itemId: 'b', text: 'hmm' });
    expect(turns[0]!.items).toEqual([
      { id: 'a', kind: 'text', text: 'Hello' },
      { id: 'b', kind: 'thinking', text: 'hmm' },
    ]);
  });

  it('does not mutate the input', () => {
    const before = [turn()];
    foldEvent(before, { type: 'text_delta', turnId: 't1', itemId: 'a', text: 'x' });
    expect(before[0]!.items).toEqual([]);
  });

  it('tracks a tool item from start to end', () => {
    let turns = [turn()];
    turns = foldEvent(turns, { type: 'tool_start', turnId: 't1', itemId: 'x', name: 'read', input: { path: 'a.md' } });
    expect(turns[0]!.items[0]).toMatchObject({ kind: 'tool', name: 'read', done: false });
    turns = foldEvent(turns, { type: 'tool_end', turnId: 't1', itemId: 'x', summary: 'Read a.md', detail: 'd', isError: false });
    expect(turns[0]!.items[0]).toMatchObject({ done: true, summary: 'Read a.md', detail: 'd', isError: false });
  });

  it('records changes, usage and the end status', () => {
    const record: ChangeRecord = { id: 'c1', op: 'edit', path: 'a.md', before: 'x', afterHash: 'h', added: 1, removed: 0 };
    let turns = [turn()];
    turns = foldEvent(turns, { type: 'change', turnId: 't1', record });
    turns = foldEvent(turns, { type: 'usage', turnId: 't1', usage: { ...ZERO_USAGE, inputTokens: 5 } });
    turns = foldEvent(turns, { type: 'turn_end', turnId: 't1', status: 'error', error: 'boom' });
    expect(turns[0]!.changes).toEqual([record]);
    expect(turns[0]!.usage?.inputTokens).toBe(5);
    expect(turns[0]).toMatchObject({ status: 'error', error: 'boom' });
    expect(turns[0]!.endedAt).toBeTruthy();
  });

  it('ignores events for unknown turns', () => {
    const turns = [turn()];
    expect(foldEvent(turns, { type: 'text_delta', turnId: 'nope', itemId: 'a', text: 'x' })).toEqual(turns);
  });
});

describe('usage helpers', () => {
  it('adds usage field-wise, including cost', () => {
    const u = addUsage({ ...ZERO_USAGE, inputTokens: 1, outputTokens: 2, costUsd: 0.5 }, { ...ZERO_USAGE, inputTokens: 3, cacheReadTokens: 4, costUsd: 0.25 });
    expect(u).toEqual({ inputTokens: 4, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0, costUsd: 0.75 });
  });

  it('loses the cost total once any part is unpriced', () => {
    expect(addUsage({ ...ZERO_USAGE, costUsd: 1 }, { ...ZERO_USAGE, costUsd: undefined }).costUsd).toBeUndefined();
  });

  it('prices a request by model and returns undefined for unknown models', () => {
    expect(estimateCost('claude-opus-5-5', { ...ZERO_USAGE, inputTokens: 1_000_000 })).toBeCloseTo(4);
    expect(estimateCost('claude-opus-5-5', { ...ZERO_USAGE, outputTokens: 1_000_000 })).toBeCloseTo(20);
    expect(estimateCost('mystery-model', { ...ZERO_USAGE, inputTokens: 1 })).toBeUndefined();
  });

  it("uses Haiku's higher rate card for prompts over 100K tokens", () => {
    const small = { ...ZERO_USAGE, inputTokens: 100_000, outputTokens: 1_000 };
    expect(estimateCost('claude-haiku-5-5', small)).toBeCloseTo(0.01 + 0.0005);
    const big = { ...ZERO_USAGE, inputTokens: 20_000, cacheReadTokens: 90_000, outputTokens: 1_000 };
    // 110K-token prompt: $0.50 in, $0.05 cache read, $2.50 out per MTok
    expect(estimateCost('claude-haiku-5-5', big)).toBeCloseTo(0.01 + 0.0045 + 0.0025);
  });
});

describe('model and effort choices', () => {
  it('offers the current Claude models and every effort level', () => {
    expect(AI_MODELS.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
    expect(AI_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('QUICK_PROMPTS', () => {
  it('has the five quick actions', () => {
    expect(QUICK_PROMPTS.map((q) => q.id)).toEqual(['summarize', 'tidy', 'tasks', 'links', 'continue']);
  });
});
