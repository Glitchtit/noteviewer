import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VaultIndex } from '../src/vault/indexer.js';
import { VaultBus } from '../src/vault/watcher.js';
import { ShareStore } from '../src/share/store.js';
import { writeNote, type VaultCtx } from '../src/vault/ops.js';
import { TOOL_DEFS, VaultTools, lineDiff } from '../src/ai/tools.js';
import { makeVault } from './helpers.js';

async function setup(files: Record<string, string>) {
  const vaultRoot = await makeVault(files);
  const index = new VaultIndex(vaultRoot);
  await index.init();
  const ctx: VaultCtx = { vaultRoot, index, bus: new VaultBus(), shares: await ShareStore.open() };
  const seen: Record<string, string> = {};
  return { ctx, seen, tools: new VaultTools(ctx, seen), read: (rel: string) => readFile(path.join(vaultRoot, rel), 'utf8') };
}

function text(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

describe('TOOL_DEFS', () => {
  it('defines the nine vault tools with streamed inputs', () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(['list', 'read', 'search', 'grep', 'links', 'write', 'edit', 'move', 'delete']);
    for (const t of TOOL_DEFS) expect(t.eager_input_streaming).toBe(true);
  });
});

describe('path confinement', () => {
  it.each(['../x.md', '/etc/passwd', '.obsidian/app.json', '.trash/a.md', 'sub/.git/config'])('rejects %s', async (p) => {
    const { tools } = await setup({ 'a.md': 'a' });
    const out = await tools.run('read', { path: p });
    expect(out.isError).toBe(true);
  });

  it('rejects unknown tools and missing inputs', async () => {
    const { tools } = await setup({});
    expect((await tools.run('bash', { command: 'ls' })).isError).toBe(true);
    expect((await tools.run('read', {})).isError).toBe(true);
    expect((await tools.run('read', { path: 42 })).isError).toBe(true);
  });
});

describe('read-only tools', () => {
  it('lists folders to the requested depth', async () => {
    const { tools } = await setup({ 'a.md': '', 'p/b.md': '', 'p/q/c.md': '' });
    const shallow = await tools.run('list', { depth: 1 });
    expect(text(shallow.content)).toContain('p/');
    expect(text(shallow.content)).not.toContain('b.md');
    const deep = await tools.run('list', { path: 'p' });
    expect(text(deep.content)).toContain('b.md');
    expect(text(deep.content)).toContain('c.md');
  });

  it('reads with line numbers, honours offset/limit and records the hash', async () => {
    const { tools, seen } = await setup({ 'a.md': 'one\ntwo\nthree' });
    const out = await tools.run('read', { path: 'a.md', offset: 2, limit: 1 });
    expect(out.isError).toBe(false);
    expect(text(out.content)).toContain('     2\ttwo');
    expect(text(out.content)).not.toContain('one');
    expect(seen['a.md']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns images as image blocks', async () => {
    const { tools } = await setup({ 'img/x.png': 'PNGDATA' });
    const out = await tools.run('read', { path: 'img/x.png' });
    expect(Array.isArray(out.content)).toBe(true);
    expect((out.content as { type: string }[])[0]!.type).toBe('image');
  });

  it('searches the index', async () => {
    const { tools } = await setup({ 'k8s.md': 'kubernetes cluster notes', 'other.md': 'cooking' });
    const out = await tools.run('search', { query: 'kubernetes' });
    expect(text(out.content)).toContain('k8s.md');
    expect(text(out.content)).not.toContain('other.md');
  });

  it('greps notes with folder filter and case folding', async () => {
    const { tools } = await setup({ 'p/a.md': 'Alpha\nbeta', 'q/b.md': 'alpha' });
    const out = await tools.run('grep', { pattern: 'alpha', path: 'p', ignore_case: true });
    expect(text(out.content)).toContain('p/a.md:1: Alpha');
    expect(text(out.content)).not.toContain('q/b.md');
    expect((await tools.run('grep', { pattern: '(' })).isError).toBe(true);
  });

  it('reports links and backlinks', async () => {
    const { tools } = await setup({ 'a.md': 'to [[b]] and [[missing]] #tag', 'b.md': 'back to [[a]]' });
    const out = text((await tools.run('links', { path: 'a.md' })).content);
    expect(out).toContain('b.md');
    expect(out).toContain('missing');
    expect(out).toContain('#tag');
  });
});

describe('write and edit', () => {
  it('creates new notes without a prior read', async () => {
    const { tools, read } = await setup({});
    const out = await tools.run('write', { path: 'new/n.md', content: 'hello\nworld' });
    expect(out.isError).toBe(false);
    expect(await read('new/n.md')).toBe('hello\nworld');
    expect(out.change).toMatchObject({ op: 'create', path: 'new/n.md', before: null, added: 2, removed: 0 });
  });

  it('refuses to overwrite a note it has not read', async () => {
    const { tools, read } = await setup({ 'a.md': 'old' });
    const out = await tools.run('write', { path: 'a.md', content: 'new' });
    expect(out.isError).toBe(true);
    expect(await read('a.md')).toBe('old');
  });

  it('only writes .md files', async () => {
    const { tools } = await setup({});
    expect((await tools.run('write', { path: 'x.txt', content: 'x' })).isError).toBe(true);
  });

  it('edits after a read and records the change', async () => {
    const { tools, read } = await setup({ 'a.md': 'alpha\nbeta\n' });
    await tools.run('read', { path: 'a.md' });
    const out = await tools.run('edit', { path: 'a.md', old_string: 'beta', new_string: 'gamma' });
    expect(out.isError).toBe(false);
    expect(await read('a.md')).toBe('alpha\ngamma\n');
    expect(out.change).toMatchObject({ op: 'edit', before: 'alpha\nbeta\n', added: 1, removed: 1 });
    expect(out.summary).toBe('Edited a.md (+1 −1)');
  });

  it('allows consecutive edits after one read', async () => {
    const { tools, read } = await setup({ 'a.md': 'a b' });
    await tools.run('read', { path: 'a.md' });
    expect((await tools.run('edit', { path: 'a.md', old_string: 'a', new_string: 'x' })).isError).toBe(false);
    expect((await tools.run('edit', { path: 'a.md', old_string: 'b', new_string: 'y' })).isError).toBe(false);
    expect(await read('a.md')).toBe('x y');
  });

  it('edit fails after an external change', async () => {
    const { tools, ctx, read } = await setup({ 'a.md': 'mine' });
    await tools.run('read', { path: 'a.md' });
    await writeNote(ctx, 'a.md', 'theirs');
    const out = await tools.run('edit', { path: 'a.md', old_string: 'theirs', new_string: 'x' });
    expect(out.isError).toBe(true);
    expect(text(out.content)).toMatch(/changed/);
    expect(await read('a.md')).toBe('theirs');
  });

  it('requires a unique match unless replace_all', async () => {
    const { tools, read } = await setup({ 'a.md': 'x x' });
    await tools.run('read', { path: 'a.md' });
    const dup = await tools.run('edit', { path: 'a.md', old_string: 'x', new_string: 'y' });
    expect(dup.isError).toBe(true);
    expect(text(dup.content)).toMatch(/2 times/);
    expect((await tools.run('edit', { path: 'a.md', old_string: 'x', new_string: 'y', replace_all: true })).isError).toBe(false);
    expect(await read('a.md')).toBe('y y');
    expect((await tools.run('edit', { path: 'a.md', old_string: 'zzz', new_string: 'q' })).isError).toBe(true);
  });
});

describe('move and delete', () => {
  it('moves a note, rewriting backlinks', async () => {
    const { tools, read } = await setup({ 'a.md': 'A', 'b.md': '[[a]]' });
    const out = await tools.run('move', { from: 'a.md', to: 'arch/a2.md' });
    expect(out.isError).toBe(false);
    expect(await read('b.md')).toBe('[[a2]]');
    expect(out.change).toMatchObject({ op: 'move', from: 'a.md', path: 'arch/a2.md', rewritten: ['b.md'] });
  });

  it('refuses to move onto an existing note', async () => {
    const { tools } = await setup({ 'a.md': 'A', 'b.md': 'B' });
    expect((await tools.run('move', { from: 'a.md', to: 'b.md' })).isError).toBe(true);
  });

  it('deletes into .trash and keeps the content for undo', async () => {
    const { tools, ctx } = await setup({ 'a.md': 'bye' });
    const out = await tools.run('delete', { path: 'a.md' });
    expect(out.change).toMatchObject({ op: 'delete', before: 'bye', afterHash: null, trashedTo: '.trash/a.md' });
    await expect(access(path.join(ctx.vaultRoot, 'a.md'))).rejects.toThrow();
  });

  it('handles unicode paths with spaces', async () => {
    const { tools, read } = await setup({ 'Möten/Vecka 1.md': 'Åtgärder' });
    expect(text((await tools.run('read', { path: 'Möten/Vecka 1.md' })).content)).toContain('Åtgärder');
    expect((await tools.run('edit', { path: 'Möten/Vecka 1.md', old_string: 'Åtgärder', new_string: 'Klart' })).isError).toBe(false);
    expect(await read('Möten/Vecka 1.md')).toBe('Klart');
    expect((await tools.run('move', { from: 'Möten/Vecka 1.md', to: 'Möten/Vecka 2.md' })).isError).toBe(false);
    expect((await tools.run('delete', { path: 'Möten/Vecka 2.md' })).isError).toBe(false);
  });
});

describe('lineDiff', () => {
  it('counts added and removed lines', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(d).toMatchObject({ added: 2, removed: 1 });
    expect(d.diff).toContain('-b');
    expect(d.diff).toContain('+B');
    expect(d.diff).toContain('+d');
  });
});
