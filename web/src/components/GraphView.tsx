import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphData } from '@noteviewer/shared';
import { api } from '../api';
import {
  filterGraph, fitTransform, ForceSimulation, hitTest, localSubgraph, toWorld,
  undirectedNeighbors, zoomAt, type SimNode, type Transform,
} from '../graph/simulation';

export interface GraphViewProps {
  /** note currently open in the editor; highlighted and used as the local-graph centre */
  currentPath: string | null;
  /** bump to refetch after the vault changes */
  refreshKey: number;
  onOpenNote(path: string): void;
  /** clicking an unresolved node creates the missing note, as Obsidian does */
  onCreateNote?(name: string): void;
}

interface Colors {
  bg: string;
  node: string;
  nodeHover: string;
  edge: string;
  accent: string;
  text: string;
  muted: string;
  unresolved: string;
}

const FALLBACK: Colors = {
  bg: '#1e1e1e', node: '#8a8a8a', nodeHover: '#dcddde', edge: '#3a3a3a',
  accent: '#8b7cf6', text: '#dcddde', muted: '#8a8a8a', unresolved: '#4a4a4a',
};

function readColors(): Colors {
  if (typeof getComputedStyle !== 'function') return FALLBACK;
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', FALLBACK.bg),
    node: v('--text-muted', FALLBACK.node),
    nodeHover: v('--text', FALLBACK.nodeHover),
    edge: v('--border', FALLBACK.edge),
    accent: v('--accent', FALLBACK.accent),
    text: v('--text', FALLBACK.text),
    muted: v('--text-muted', FALLBACK.muted),
    unresolved: v('--bg-active', FALLBACK.unresolved),
  };
}

type Drag =
  | { kind: 'node'; node: SimNode; startX: number; startY: number; moved: boolean }
  | { kind: 'pan'; lastX: number; lastY: number; moved: boolean };

const EMPTY: GraphData = { nodes: [], edges: [] };

export function GraphView({ currentPath, refreshKey, onOpenNote, onCreateNote }: GraphViewProps) {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'global' | 'local'>('global');
  const [depth, setDepth] = useState(1);
  const [showOrphans, setShowOrphans] = useState(true);
  const [showUnresolved, setShowUnresolved] = useState(true);
  const [hovered, setHovered] = useState<SimNode | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<ForceSimulation>(new ForceSimulation());
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<Drag | null>(null);
  const hoveredRef = useRef<SimNode | null>(null);
  const autoFitRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const dirtyRef = useRef(true);
  const colorsRef = useRef<Colors>(FALLBACK);
  const queryRef = useRef('');
  const currentRef = useRef<string | null>(currentPath);
  const neighborsRef = useRef<Map<string, Set<string>>>(new Map());
  queryRef.current = query.trim().toLowerCase();
  currentRef.current = currentPath;

  // Fetch, debounced on refreshes so a burst of vault events costs one request.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.graph().then((g) => {
        if (cancelled) return;
        setData(g);
        setError(null);
      }).catch(() => {
        if (!cancelled) setError('Failed to load graph.');
      });
    };
    const id = setTimeout(load, refreshKey === 0 ? 0 : 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [refreshKey]);

  const view = useMemo(() => {
    if (!data) return EMPTY;
    const scoped = mode === 'local' && currentPath ? localSubgraph(data, currentPath, depth) : data;
    return filterGraph(scoped, { showOrphans, showUnresolved });
  }, [data, mode, currentPath, depth, showOrphans, showUnresolved]);

  const size = useCallback(() => {
    const el = containerRef.current;
    // jsdom reports 0x0; fall back to a sane viewport so fit/hit maths stay finite.
    return { w: el?.clientWidth || 800, h: el?.clientHeight || 600 };
  }, []);

  const fit = useCallback(() => {
    const b = simRef.current.bounds();
    if (!b) return;
    const { w, h } = size();
    transformRef.current = fitTransform(b, w, h);
    dirtyRef.current = true;
  }, [size]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = size();
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const c = colorsRef.current;
    const t = transformRef.current;
    const sim = simRef.current;
    const q = queryRef.current;
    const hov = hoveredRef.current;
    const current = currentRef.current;

    // Highlight set: hovered node + neighbours, else filter matches.
    let focus: Set<string> | null = null;
    if (hov) {
      focus = new Set([hov.id, ...(neighborsRef.current.get(hov.id) ?? [])]);
    } else if (q) {
      focus = new Set(sim.nodes.filter((n) => matches(n, q)).map((n) => n.id));
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);

    ctx.lineWidth = 1 / t.k;
    for (const l of sim.links) {
      const lit = !focus || (focus.has(l.source.id) && focus.has(l.target.id) && (!hov || l.source === hov || l.target === hov));
      ctx.strokeStyle = lit && hov ? c.muted : c.edge;
      ctx.globalAlpha = focus && !lit ? 0.12 : 0.9;
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
    }

    for (const n of sim.nodes) {
      const lit = !focus || focus.has(n.id);
      ctx.globalAlpha = lit ? 1 : 0.18;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      if (n.node.unresolved) {
        ctx.fillStyle = c.unresolved;
        ctx.fill();
        ctx.strokeStyle = c.muted;
        ctx.stroke();
      } else {
        ctx.fillStyle = n.id === current ? c.accent : n === hov ? c.nodeHover : c.node;
        ctx.fill();
      }
      if (n.id === current) {
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 2 / t.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 3 / t.k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1 / t.k;
      }
    }

    // Labels fade in with zoom; focused/hovered/current nodes always get one.
    const zoomAlpha = Math.max(0, Math.min(1, (t.k - 0.55) / 0.9));
    ctx.font = `${11 / t.k}px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const n of sim.nodes) {
      const forced = n === hov || n.id === current || (focus?.has(n.id) ?? false);
      const alpha = forced ? 1 : zoomAlpha * (n.degree >= 3 ? 1 : 0.75);
      if (alpha <= 0.02) continue;
      if (focus && !focus.has(n.id)) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = n === hov ? c.text : c.muted;
      ctx.fillText(n.node.title, n.x, n.y + n.radius + 3 / t.k);
    }
    ctx.globalAlpha = 1;
  }, [size]);

  const loop = useCallback(() => {
    rafRef.current = null;
    const sim = simRef.current;
    let active = false;
    // Two ticks per frame settle the layout faster without visible jitter.
    for (let i = 0; i < 2; i++) active = sim.tick() || active;
    if (active && autoFitRef.current) fit();
    if (active || dirtyRef.current) {
      dirtyRef.current = false;
      draw();
    }
    if (active) rafRef.current = requestAnimationFrame(loop);
  }, [draw, fit]);

  const wake = useCallback(() => {
    dirtyRef.current = true;
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(loop);
  }, [loop]);

  // Push the filtered graph into the simulation whenever it changes.
  useEffect(() => {
    const sim = simRef.current;
    sim.setData(view);
    neighborsRef.current = undirectedNeighbors(view);
    autoFitRef.current = true;
    hoveredRef.current = null;
    setHovered(null);
    wake();
  }, [view, wake]);

  useEffect(() => {
    colorsRef.current = readColors();
    const el = containerRef.current;
    if (!el) return;
    const onResize = () => wake();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(onResize);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [wake]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  // Wheel must be non-passive to stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      transformRef.current = zoomAt(transformRef.current, e.clientX - r.left, e.clientY - r.top, factor);
      autoFitRef.current = false;
      wake();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [wake]);

  useEffect(() => { wake(); }, [query, currentPath, wake]);

  const pointerWorld = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top, ...toWorld(transformRef.current, e.clientX - r.left, e.clientY - r.top) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { sx, sy, x, y } = pointerWorld(e);
    const hit = hitTest(simRef.current.nodes, x, y, 3 / transformRef.current.k);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (hit) {
      hit.fixed = true;
      dragRef.current = { kind: 'node', node: hit, startX: sx, startY: sy, moved: false };
    } else {
      dragRef.current = { kind: 'pan', lastX: sx, lastY: sy, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { sx, sy, x, y } = pointerWorld(e);
    const drag = dragRef.current;
    if (drag?.kind === 'node') {
      if (Math.hypot(sx - drag.startX, sy - drag.startY) > 4) drag.moved = true;
      drag.node.x = x;
      drag.node.y = y;
      autoFitRef.current = false;
      simRef.current.reheat(0.3);
      wake();
      return;
    }
    if (drag?.kind === 'pan') {
      const dx = sx - drag.lastX;
      const dy = sy - drag.lastY;
      if (Math.hypot(dx, dy) > 0) drag.moved = true;
      drag.lastX = sx;
      drag.lastY = sy;
      transformRef.current = { ...transformRef.current, x: transformRef.current.x + dx, y: transformRef.current.y + dy };
      autoFitRef.current = false;
      wake();
      return;
    }
    const hit = hitTest(simRef.current.nodes, x, y, 3 / transformRef.current.k) ?? null;
    if (hit !== hoveredRef.current) {
      hoveredRef.current = hit;
      setHovered(hit);
      e.currentTarget.style.cursor = hit ? 'pointer' : 'grab';
      wake();
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>, click: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag?.kind === 'node') {
      drag.node.fixed = false;
      simRef.current.reheat(0.2);
      wake();
      if (click && !drag.moved) activate(drag.node);
    }
  };

  const activate = (n: SimNode) => {
    if (n.node.unresolved) onCreateNote?.(n.id);
    else onOpenNote(n.id);
  };

  const onPointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) endDrag(e, false);
    if (hoveredRef.current) {
      hoveredRef.current = null;
      setHovered(null);
      wake();
    }
  };

  const onQueryKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const q = queryRef.current;
    if (!q) return;
    const nodes = simRef.current.nodes.filter((n) => matches(n, q));
    // Prefer an exact title match, then the best-connected match.
    const exact = nodes.find((n) => n.node.title.toLowerCase() === q);
    const pick = exact ?? nodes.sort((a, b) => b.degree - a.degree)[0];
    if (pick) activate(pick);
  };

  return (
    <div className="graph-view" ref={containerRef} data-testid="graph-view">
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        role="img"
        aria-label="Note graph"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onPointerLeave={onPointerLeave}
        onDoubleClick={() => { autoFitRef.current = false; fit(); wake(); }}
      />
      <div className="graph-controls">
        <input
          aria-label="Filter graph"
          placeholder="Filter notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onQueryKey}
        />
        {currentPath && (
          <div className="graph-mode" role="group" aria-label="Graph scope">
            <button aria-pressed={mode === 'global'} onClick={() => setMode('global')}>Global</button>
            <button aria-pressed={mode === 'local'} onClick={() => setMode('local')}>Local</button>
            {mode === 'local' && (
              <select aria-label="Local graph depth" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                <option value={1}>1 hop</option>
                <option value={2}>2 hops</option>
                <option value={3}>3 hops</option>
              </select>
            )}
          </div>
        )}
        <label><input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} /> Orphans</label>
        <label><input type="checkbox" checked={showUnresolved} onChange={(e) => setShowUnresolved(e.target.checked)} /> Unresolved</label>
        <button aria-label="Fit graph to view" onClick={() => { autoFitRef.current = false; fit(); wake(); }}>Fit</button>
      </div>
      <div className="graph-status" data-testid="graph-status">
        {error ?? (data
          ? `${view.nodes.length} notes · ${view.edges.length} links${hovered ? ` · ${hovered.id}` : ''}`
          : 'Loading graph…')}
      </div>
    </div>
  );
}

function matches(n: SimNode, q: string): boolean {
  return n.node.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)
    || n.node.tags.some((t) => t.toLowerCase().includes(q));
}
