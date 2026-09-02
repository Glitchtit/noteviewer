import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GraphData } from '@noteviewer/shared';
import { buildApp } from '../src/app.js';
import { VaultIndex } from '../src/vault/indexer.js';
import { makeVault } from './helpers.js';

let app: FastifyInstance;
afterEach(() => app?.close());

async function indexFor(files: Record<string, string>): Promise<VaultIndex> {
  const idx = new VaultIndex(await makeVault(files));
  await idx.init();
  return idx;
}

function byId(g: GraphData, id: string) {
  return g.nodes.find((n) => n.id === id)!;
}

describe('VaultIndex.graph', () => {
  it('emits one node per note and one directed edge per resolved link', async () => {
    const idx = await indexFor({
      'a.md': '# A\n\nSee [[b]] and [[sub/c|alias]] and [[b#heading]].',
      'b.md': '# B\n\nBack to [[a]].',
      'sub/c.md': '# C',
    });
    const g = idx.graph();
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'b.md', 'sub/c.md']);
    expect(g.edges).toEqual([
      { source: 'a.md', target: 'b.md' },
      { source: 'a.md', target: 'sub/c.md' },
      { source: 'b.md', target: 'a.md' },
    ]);
    expect(byId(g, 'a.md')).toMatchObject({ title: 'A', inbound: 1, outbound: 2, unresolved: false });
    expect(byId(g, 'b.md')).toMatchObject({ inbound: 1, outbound: 1 });
    expect(byId(g, 'sub/c.md')).toMatchObject({ inbound: 1, outbound: 0 });
  });

  it('adds unresolved link targets as phantom nodes, deduplicated across notes', async () => {
    const idx = await indexFor({
      'a.md': 'todo [[Missing]] and again [[Missing|x]]',
      'b.md': '[[Missing#part]]',
    });
    const g = idx.graph();
    const phantom = byId(g, 'Missing');
    expect(phantom).toMatchObject({ title: 'Missing', unresolved: true, inbound: 2, outbound: 0, tags: [] });
    expect(g.nodes.filter((n) => n.unresolved)).toHaveLength(1);
    expect(g.edges).toEqual([
      { source: 'a.md', target: 'Missing' },
      { source: 'b.md', target: 'Missing' },
    ]);
  });

  it('ignores self-links and carries note tags', async () => {
    const idx = await indexFor({
      'a.md': '---\ntags: [x, y]\n---\n# A\n\n[[a]] #inline',
    });
    const g = idx.graph();
    expect(g.edges).toEqual([]);
    expect(byId(g, 'a.md').tags).toEqual(['x', 'y', 'inline']);
    expect(byId(g, 'a.md').outbound).toBe(0);
  });

  it('drops nodes and edges when a note is removed', async () => {
    const idx = await indexFor({ 'a.md': '[[b]]', 'b.md': '' });
    idx.removeNote('b.md');
    const g = idx.graph();
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'b']);
    expect(byId(g, 'b').unresolved).toBe(true);
  });
});

describe('GET /api/graph', () => {
  it('returns the vault graph and excludes hidden directories', async () => {
    const root = await makeVault({
      'a.md': '[[b]]',
      'b.md': '',
      '.trash/old.md': '[[a]]',
    });
    app = await buildApp({ vaultRoot: root });
    const res = await app.inject({ url: '/api/graph' });
    expect(res.statusCode).toBe(200);
    const g = res.json() as GraphData;
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'b.md']);
    expect(g.edges).toEqual([{ source: 'a.md', target: 'b.md' }]);
  });

  it('reflects saves made through the API', async () => {
    const root = await makeVault({ 'a.md': '', 'b.md': '' });
    app = await buildApp({ vaultRoot: root });
    await app.inject({ method: 'PUT', url: '/api/note/a.md', payload: { content: 'now [[b]]' } });
    const g = (await app.inject({ url: '/api/graph' })).json() as GraphData;
    expect(g.edges).toEqual([{ source: 'a.md', target: 'b.md' }]);
  });
});
