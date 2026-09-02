import { describe, expect, it } from 'vitest';
import type { GraphData } from '@noteviewer/shared';
import {
  filterGraph, fitTransform, ForceSimulation, hitTest, localSubgraph, toScreen, toWorld, zoomAt,
} from '../src/graph/simulation';

function node(id: string, extra: Partial<GraphData['nodes'][number]> = {}) {
  return { id, title: id.replace(/\.md$/, ''), tags: [], unresolved: false, inbound: 0, outbound: 0, ...extra };
}

const chain: GraphData = {
  nodes: [node('a.md'), node('b.md'), node('c.md'), node('d.md'), node('lonely.md'), node('Ghost', { unresolved: true })],
  edges: [
    { source: 'a.md', target: 'b.md' },
    { source: 'b.md', target: 'c.md' },
    { source: 'c.md', target: 'd.md' },
    { source: 'a.md', target: 'Ghost' },
  ],
};

describe('localSubgraph', () => {
  it('keeps nodes within N undirected hops of the centre', () => {
    const one = localSubgraph(chain, 'b.md', 1);
    expect(one.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'b.md', 'c.md']);
    expect(one.edges).toHaveLength(2);
    const two = localSubgraph(chain, 'b.md', 2);
    expect(two.nodes.map((n) => n.id).sort()).toEqual(['Ghost', 'a.md', 'b.md', 'c.md', 'd.md']);
  });

  it('returns the whole graph when the centre is unknown', () => {
    expect(localSubgraph(chain, 'nope.md', 1)).toBe(chain);
  });
});

describe('filterGraph', () => {
  it('drops orphans and unresolved nodes on request, pruning dangling edges', () => {
    const all = filterGraph(chain, { showOrphans: true, showUnresolved: true });
    expect(all.nodes).toHaveLength(6);
    const noOrphans = filterGraph(chain, { showOrphans: false, showUnresolved: true });
    expect(noOrphans.nodes.map((n) => n.id)).not.toContain('lonely.md');
    const noGhost = filterGraph(chain, { showOrphans: true, showUnresolved: false });
    expect(noGhost.nodes.map((n) => n.id)).not.toContain('Ghost');
    expect(noGhost.edges).toHaveLength(3);
  });
});

describe('ForceSimulation', () => {
  it('spreads nodes apart and pulls linked nodes closer than unlinked ones', () => {
    const sim = new ForceSimulation();
    sim.setData(chain);
    expect(sim.nodes).toHaveLength(6);
    expect(sim.links).toHaveLength(4);
    let ticks = 0;
    while (sim.tick() && ticks < 2000) ticks++;
    expect(sim.active).toBe(false);
    const dist = (p: string, q: string) => {
      const a = sim.get(p)!, b = sim.get(q)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    expect(dist('a.md', 'b.md')).toBeLessThan(dist('a.md', 'd.md'));
    for (const p of sim.nodes) for (const q of sim.nodes) {
      if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(p.radius + q.radius);
    }
    expect(sim.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it('is deterministic across runs', () => {
    const run = () => {
      const sim = new ForceSimulation();
      sim.setData(chain);
      for (let i = 0; i < 50; i++) sim.tick();
      return sim.nodes.map((n) => [n.x, n.y]);
    };
    expect(run()).toEqual(run());
  });

  it('keeps existing positions on refresh and places new nodes near a neighbour', () => {
    const sim = new ForceSimulation();
    sim.setData(chain);
    for (let i = 0; i < 30; i++) sim.tick();
    const before = { ...sim.get('c.md')! };
    const grown: GraphData = {
      nodes: [...chain.nodes, node('e.md')],
      edges: [...chain.edges, { source: 'c.md', target: 'e.md' }],
    };
    sim.setData(grown);
    const c = sim.get('c.md')!;
    expect(c.x).toBe(before.x);
    expect(c.y).toBe(before.y);
    const e = sim.get('e.md')!;
    expect(Math.hypot(e.x - c.x, e.y - c.y)).toBeLessThan(20);
    expect(sim.active).toBe(true);
  });

  it('sizes nodes by degree and does not move pinned nodes', () => {
    const sim = new ForceSimulation();
    sim.setData(chain);
    expect(sim.get('a.md')!.radius).toBeGreaterThan(sim.get('lonely.md')!.radius);
    const a = sim.get('a.md')!;
    a.fixed = true;
    a.x = 123;
    a.y = -45;
    for (let i = 0; i < 20; i++) sim.tick();
    expect(a.x).toBe(123);
    expect(a.y).toBe(-45);
  });

  it('handles an empty graph', () => {
    const sim = new ForceSimulation();
    sim.setData({ nodes: [], edges: [] });
    expect(sim.tick()).toBe(true);
    expect(sim.bounds()).toBeNull();
  });
});

describe('hitTest and transforms', () => {
  it('finds the node under a world point within its radius plus slop', () => {
    const sim = new ForceSimulation();
    sim.setData(chain);
    const a = sim.get('a.md')!;
    expect(hitTest(sim.nodes, a.x + a.radius + 1, a.y)?.id).toBe('a.md');
    expect(hitTest(sim.nodes, a.x + a.radius + 50, a.y + 400)).toBeUndefined();
  });

  it('round-trips world and screen coordinates and zooms around a point', () => {
    const t = { x: 10, y: 20, k: 2 };
    const s = toScreen(t, 5, 7);
    expect(s).toEqual({ x: 20, y: 34 });
    expect(toWorld(t, s.x, s.y)).toEqual({ x: 5, y: 7 });
    const z = zoomAt(t, 20, 34, 1.5);
    expect(z.k).toBeCloseTo(3);
    expect(toWorld(z, 20, 34)).toEqual({ x: 5, y: 7 });
    expect(zoomAt(t, 0, 0, 100).k).toBe(8);
    expect(zoomAt(t, 0, 0, 0.0001).k).toBe(0.1);
  });

  it('fits bounds inside the viewport', () => {
    const t = fitTransform({ minX: -100, minY: -50, maxX: 100, maxY: 50 }, 300, 300, 0);
    expect(t.k).toBe(1.5);
    expect(toScreen(t, 0, 0)).toEqual({ x: 150, y: 150 });
    expect(toScreen(t, -100, 0).x).toBe(0);
    // Zoom is capped so a tiny local graph does not fill the screen with huge discs.
    expect(fitTransform({ minX: -10, minY: -10, maxX: 10, maxY: 10 }, 800, 600).k).toBe(1.8);
  });
});
