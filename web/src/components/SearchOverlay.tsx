import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchResult } from '@noteviewer/shared';
import { api } from '../api';

export interface SearchOverlayProps {
  mode: 'switcher' | 'search';
  notePaths: string[];
  onOpen(path: string): void;
  onClose(): void;
}

function fuzzy(q: string, s: string): number {
  const query = q.toLowerCase();
  const target = s.toLowerCase();
  let qi = 0;
  let first = -1;
  for (let i = 0; i < target.length && qi < query.length; i++) {
    if (target[i] === query[qi]) {
      if (first < 0) first = i;
      qi++;
    }
  }
  if (qi < query.length) return -1;
  return first * 1000 + s.length;
}

export function SearchOverlay({ mode, notePaths, onOpen, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [remote, setRemote] = useState<SearchResult[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqSeq = useRef(0);

  const results = useMemo<{ path: string; label: string; sub?: string }[]>(() => {
    if (mode === 'switcher') {
      if (!query.trim()) return notePaths.slice(0, 20).map((p) => ({ path: p, label: p }));
      return notePaths
        .map((p) => ({ p, score: fuzzy(query, p) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => a.score - b.score)
        .slice(0, 20)
        .map((x) => ({ path: x.p, label: x.p }));
    }
    return remote.map((r) => ({ path: r.path, label: r.title, sub: r.path }));
  }, [mode, query, notePaths, remote]);

  useEffect(() => {
    if (mode !== 'search') return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      reqSeq.current += 1;
      setRemote([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      const seq = ++reqSeq.current;
      void api.search(query).then((r) => {
        if (seq === reqSeq.current) setRemote(r);
      }).catch(() => {});
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mode, query]);

  useEffect(() => setSelected(0), [query]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      const r = results[selected];
      if (r) onOpen(r.path);
    }
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={mode === 'switcher' ? 'Jump to note…' : 'Search vault…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="overlay-results">
          {results.map((r, i) => (
            <li key={r.path} className={i === selected ? 'selected' : ''}>
              <button onClick={() => onOpen(r.path)}>
                {r.label}
                {r.sub && <span className="overlay-sub">{r.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
