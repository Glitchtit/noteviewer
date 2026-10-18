/**
 * Remembers where the user was — open note, read/edit mode, per-note
 * scroll position and expanded tree folders — so a page refresh lands
 * back in the same spot.
 * Best effort: when storage is unavailable nothing is remembered.
 */
const LAST_KEY = 'noteviewer.lastNote';
const SCROLL_KEY = 'noteviewer.scroll';
const FOLDERS_KEY = 'noteviewer.expandedFolders';
/** cap on remembered scroll positions; the oldest are dropped first */
const MAX_SCROLL_ENTRIES = 100;

export type ViewMode = 'edit' | 'read';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable or full: the position just isn't remembered
  }
}

export function loadLastNote(): { path: string; viewMode: ViewMode } | null {
  const v = read<{ path?: unknown; viewMode?: unknown }>(LAST_KEY);
  if (!v || typeof v.path !== 'string' || !v.path) return null;
  return { path: v.path, viewMode: v.viewMode === 'read' ? 'read' : 'edit' };
}

export function saveLastNote(path: string | null, viewMode: ViewMode): void {
  write(LAST_KEY, path ? { path, viewMode } : null);
}

/** `view` keeps reading (pixels) and editing (document offset) positions apart */
type ScrollMap = Record<string, number>;
const scrollId = (path: string, view: ViewMode) => `${view}:${path}`;

export function loadScroll(path: string, view: ViewMode): number | undefined {
  const v = read<ScrollMap>(SCROLL_KEY)?.[scrollId(path, view)];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function saveScroll(path: string, view: ViewMode, value: number): void {
  const map = read<ScrollMap>(SCROLL_KEY) ?? {};
  const id = scrollId(path, view);
  delete map[id]; // re-insert so the most recent entries sort last
  map[id] = Math.round(value);
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SCROLL_ENTRIES))) delete map[k];
  write(SCROLL_KEY, map);
}

/** folders since renamed or deleted linger harmlessly: nothing in the tree matches them */
export function loadExpandedFolders(): Set<string> {
  const v = read<unknown>(FOLDERS_KEY);
  return new Set(Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : []);
}

export function saveExpandedFolders(folders: ReadonlySet<string>): void {
  write(FOLDERS_KEY, [...folders]);
}
