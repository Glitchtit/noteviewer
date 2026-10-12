import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShareStore } from '../src/share/store.js';

afterEach(() => vi.useRealTimers());

describe('ShareStore', () => {
  it('creates unguessable tokens and looks them up', async () => {
    const store = await ShareStore.open();
    const a = await store.create('a.md', null);
    const b = await store.create('a.md', null);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.token).not.toBe(b.token);
    expect(store.get(a.token)?.path).toBe('a.md');
    expect(store.get('nope')).toBeUndefined();
  });

  it('hides expired shares and lists only live shares for a path', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-01T00:00:00Z') });
    const store = await ShareStore.open();
    const week = await store.create('a.md', 7);
    const forever = await store.create('a.md', null);
    await store.create('b.md', null);
    expect(week.expiresAt).toBe('2026-10-08T00:00:00.000Z');
    expect(store.list('a.md').map((s) => s.token)).toEqual([week.token, forever.token]);
    vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    expect(store.get(week.token)).toBeUndefined();
    expect(store.list('a.md').map((s) => s.token)).toEqual([forever.token]);
  });

  it('revokes, follows renames, and drops deleted notes', async () => {
    const store = await ShareStore.open();
    const a = await store.create('a.md', null);
    const b = await store.create('b.md', null);
    expect(await store.revoke(a.token)).toBe(true);
    expect(await store.revoke(a.token)).toBe(false);
    expect(store.get(a.token)).toBeUndefined();
    await store.renamePath('b.md', 'sub/c.md');
    expect(store.get(b.token)?.path).toBe('sub/c.md');
    await store.removePath('sub/c.md');
    expect(store.get(b.token)).toBeUndefined();
  });

  it('persists to disk and reloads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'noteviewer-data-'));
    const store = await ShareStore.open(dir);
    const s = await store.create('a.md', 30);
    const raw = JSON.parse(await readFile(path.join(dir, 'shares.json'), 'utf8'));
    expect(raw.shares[0].token).toBe(s.token);
    const reopened = await ShareStore.open(dir);
    expect(reopened.get(s.token)).toEqual(s);
  });
});
