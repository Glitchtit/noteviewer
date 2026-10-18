import { useEffect, useRef } from 'react';
import { loadScroll, saveScroll, type ViewMode } from '../readingPosition';

const SAVE_DELAY_MS = 200;
const INTENT_EVENTS = ['wheel', 'touchstart', 'pointerdown'] as const;
const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' ']);

export interface ScrollMemoryOptions {
  /** the scrolling element; read after mount */
  scroller(): HTMLElement | null;
  /** note path; undefined disables remembering (e.g. the public share view) */
  key: string | undefined;
  view: ViewMode;
  /** current position worth storing */
  position(): number;
  /** move to a stored position */
  restore(value: number): void;
  /** re-apply the stored position whenever this changes (e.g. freshly rendered content) */
  ready: unknown;
}

/**
 * Persists a note's scroll position and restores it on the next mount.
 * Restoring re-runs as late images load and grow the page, until the user
 * scrolls themselves; only user-driven scrolling is saved, so a restore
 * clamped by not-yet-loaded content never overwrites the stored spot.
 */
export function useScrollMemory(opts: ScrollMemoryOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const userMoved = useRef(false);
  const { key, view, ready } = opts;

  useEffect(() => {
    userMoved.current = false;
  }, [key, view]);

  useEffect(() => {
    const el = optsRef.current.scroller();
    if (!el || !key) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      saveScroll(key, view, optsRef.current.position());
    };
    const onScroll = () => {
      if (!userMoved.current) return;
      clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY_MS);
    };
    const onIntent = () => {
      userMoved.current = true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) userMoved.current = true;
    };
    for (const t of INTENT_EVENTS) el.addEventListener(t, onIntent, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', flush);
    return () => {
      flush();
      for (const t of INTENT_EVENTS) el.removeEventListener(t, onIntent);
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', flush);
    };
  }, [key, view]);

  useEffect(() => {
    const el = optsRef.current.scroller();
    if (!el || !key) return;
    const stored = loadScroll(key, view);
    if (stored === undefined) return;
    const apply = () => {
      if (!userMoved.current) optsRef.current.restore(stored);
    };
    apply();
    // image load events don't bubble; capture them from inside the scroller
    el.addEventListener('load', apply, true);
    return () => el.removeEventListener('load', apply, true);
  }, [key, view, ready]);
}
