import type { GraphData, GraphNode } from '@noteviewer/shared';

/** A node with layout state. `x`/`y` are world coordinates. */
export interface SimNode {
  id: string;
  node: GraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** total undirected degree used for sizing and hit-testing */
  degree: number;
  /** pinned by a drag: forces still push others but do not move this node */
  fixed: boolean;
}

export interface SimLink {
  source: SimNode;
  target: SimNode;
}

export interface SimOptions {
  /** Coulomb-style pairwise repulsion strength */
  repulsion: number;
  /** resting length of a link */
  linkDistance: number;
  /** spring constant pulling linked nodes together */
  linkStrength: number;
  /** pull toward the origin, keeps disconnected components from drifting apart */
  centerStrength: number;
  /** velocity retained per tick (0..1) */
  damping: number;
  /** alpha multiplies every force; it decays each tick until the layout freezes */
  alphaDecay: number;
  alphaMin: number;
}

export const DEFAULT_OPTIONS: SimOptions = {
  repulsion: 900,
  linkDistance: 60,
  linkStrength: 0.08,
  centerStrength: 0.012,
  damping: 0.6,
  alphaDecay: 0.025,
  alphaMin: 0.003,
};

export function nodeRadius(degree: number): number {
  return 4 + Math.sqrt(degree) * 1.8;
}

/**
 * Deterministic starting position: a phyllotaxis spiral (same idea d3 uses).
 * No randomness means tests and repeated loads produce the same layout.
 */
function initialPosition(i: number, count: number): { x: number; y: number } {
  const spacing = 18 + Math.sqrt(count) * 1.5;
  const angle = i * 2.399963229728653; // golden angle
  const r = spacing * Math.sqrt(i + 0.5);
  return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
}

export function undirectedNeighbors(data: GraphData): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const n of data.nodes) adj.set(n.id, new Set());
  for (const e of data.edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }
  return adj;
}

/**
 * Sub-graph reachable from `center` within `depth` undirected hops — the
 * "local graph" mode. Returns the full graph unchanged when `center` is not
 * a node.
 */
export function localSubgraph(data: GraphData, center: string, depth: number): GraphData {
  if (!data.nodes.some((n) => n.id === center)) return data;
  const adj = undirectedNeighbors(data);
  const keep = new Set<string>([center]);
  let frontier = [center];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!keep.has(nb)) {
          keep.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: data.nodes.filter((n) => keep.has(n.id)),
    edges: data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

export interface GraphFilter {
  showOrphans: boolean;
  showUnresolved: boolean;
}

/** Apply the display toggles. Orphans are nodes with no edges at all. */
export function filterGraph(data: GraphData, filter: GraphFilter): GraphData {
  let nodes = data.nodes;
  if (!filter.showUnresolved) nodes = nodes.filter((n) => !n.unresolved);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  if (!filter.showOrphans) {
    const linked = new Set<string>();
    for (const e of edges) {
      linked.add(e.source);
      linked.add(e.target);
    }
    nodes = nodes.filter((n) => linked.has(n.id));
  }
  return { nodes, edges };
}

export class ForceSimulation {
  nodes: SimNode[] = [];
  links: SimLink[] = [];
  alpha = 1;
  readonly opts: SimOptions;
  private byId = new Map<string, SimNode>();

  constructor(opts: Partial<SimOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /**
   * Replace the graph, keeping positions of nodes that already existed so a
   * background refresh does not scramble the layout. New nodes spawn beside
   * a linked neighbour when one exists, otherwise on the spiral.
   */
  setData(data: GraphData): void {
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const prev = this.byId;
    const next = new Map<string, SimNode>();
    const nodes: SimNode[] = [];
    data.nodes.forEach((n, i) => {
      const d = degree.get(n.id) ?? 0;
      const existing = prev.get(n.id);
      if (existing) {
        existing.node = n;
        existing.degree = d;
        existing.radius = nodeRadius(d);
        next.set(n.id, existing);
        nodes.push(existing);
        return;
      }
      const p = initialPosition(i, data.nodes.length);
      const sn: SimNode = {
        id: n.id, node: n, x: p.x, y: p.y, vx: 0, vy: 0,
        radius: nodeRadius(d), degree: d, fixed: false,
      };
      next.set(n.id, sn);
      nodes.push(sn);
    });
    if (prev.size > 0) {
      // Spawn genuinely new nodes next to a linked neighbour that survived.
      const adj = undirectedNeighbors(data);
      for (const sn of nodes) {
        if (prev.has(sn.id)) continue;
        for (const nb of adj.get(sn.id) ?? []) {
          const anchor = prev.get(nb);
          if (anchor) {
            sn.x = anchor.x + 8;
            sn.y = anchor.y - 8;
            break;
          }
        }
      }
    }
    this.nodes = nodes;
    this.byId = next;
    this.links = [];
    for (const e of data.edges) {
      const s = next.get(e.source);
      const t = next.get(e.target);
      if (s && t) this.links.push({ source: s, target: t });
    }
    this.alpha = 1;
  }

  get(id: string): SimNode | undefined {
    return this.byId.get(id);
  }

  reheat(alpha = 0.6): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  get active(): boolean {
    return this.alpha > this.opts.alphaMin;
  }

  /** Advance one step. Returns false once the layout has frozen. */
  tick(): boolean {
    if (!this.active) return false;
    const { repulsion, linkDistance, linkStrength, centerStrength, damping } = this.opts;
    const a = this.alpha;
    const nodes = this.nodes;
    const n = nodes.length;

    // Pairwise repulsion. O(n^2) but each pair is cheap; a few thousand notes
    // still tick in well under a frame, and the loop stops once alpha decays.
    for (let i = 0; i < n; i++) {
      const p = nodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const q = nodes[j]!;
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 === 0) {
          // coincident nodes: nudge deterministically so they separate
          dx = 0.1 * ((i % 3) - 1 || 1);
          dy = 0.1 * ((j % 3) - 1 || 1);
          d2 = dx * dx + dy * dy;
        }
        if (d2 > 250_000) continue; // beyond 500px the force is negligible
        const f = (repulsion * a) / d2;
        const fx = dx * f;
        const fy = dy * f;
        p.vx -= fx;
        p.vy -= fy;
        q.vx += fx;
        q.vy += fy;
      }
    }

    // Springs along links.
    for (const l of this.links) {
      const dx = l.target.x - l.source.x;
      const dy = l.target.y - l.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = linkDistance + l.source.radius + l.target.radius;
      const f = ((dist - rest) * linkStrength * a) / dist;
      const fx = dx * f;
      const fy = dy * f;
      l.source.vx += fx;
      l.source.vy += fy;
      l.target.vx -= fx;
      l.target.vy -= fy;
    }

    // Gravity toward the origin and integration.
    for (const p of nodes) {
      p.vx -= p.x * centerStrength * a;
      p.vy -= p.y * centerStrength * a;
      p.vx *= damping;
      p.vy *= damping;
      if (p.fixed) {
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      p.x += p.vx;
      p.y += p.vy;
    }

    this.alpha -= this.alpha * this.opts.alphaDecay;
    return this.active;
  }

  /** Axis-aligned bounds of all nodes, padded by their radii. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.nodes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.nodes) {
      minX = Math.min(minX, p.x - p.radius);
      minY = Math.min(minY, p.y - p.radius);
      maxX = Math.max(maxX, p.x + p.radius);
      maxY = Math.max(maxY, p.y + p.radius);
    }
    return { minX, minY, maxX, maxY };
  }
}

/** Topmost node whose disc (plus `slop` px) contains the world point. */
export function hitTest(nodes: SimNode[], x: number, y: number, slop = 3): SimNode | undefined {
  let best: SimNode | undefined;
  let bestD = Infinity;
  for (const p of nodes) {
    const dx = p.x - x;
    const dy = p.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= p.radius + slop && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export function toWorld(t: Transform, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
}

export function toScreen(t: Transform, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * t.k + t.x, y: wy * t.k + t.y };
}

/** Zoom by `factor` keeping the screen point (sx, sy) fixed. */
export function zoomAt(t: Transform, sx: number, sy: number, factor: number, min = 0.1, max = 8): Transform {
  const k = Math.min(max, Math.max(min, t.k * factor));
  const ratio = k / t.k;
  return { k, x: sx - (sx - t.x) * ratio, y: sy - (sy - t.y) * ratio };
}

/** Transform that fits `bounds` inside a width x height viewport with padding. */
export function fitTransform(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  width: number,
  height: number,
  padding = 40,
): Transform {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const k = Math.min(1.8, Math.max(0.1, Math.min((width - padding * 2) / bw, (height - padding * 2) / bh)));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
}
