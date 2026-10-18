import { beforeEach, describe, expect, it } from 'vitest';
import { loadLastNote, loadScroll, saveLastNote, saveScroll } from '../src/readingPosition';

beforeEach(() => localStorage.clear());

describe('readingPosition', () => {
  it('round-trips the last open note and view mode', () => {
    expect(loadLastNote()).toBeNull();
    saveLastNote('dir/a.md', 'read');
    expect(loadLastNote()).toEqual({ path: 'dir/a.md', viewMode: 'read' });
    saveLastNote(null, 'edit');
    expect(loadLastNote()).toBeNull();
  });

  it('ignores corrupt stored values', () => {
    localStorage.setItem('noteviewer.lastNote', '{not json');
    expect(loadLastNote()).toBeNull();
    localStorage.setItem('noteviewer.lastNote', JSON.stringify({ path: 5 }));
    expect(loadLastNote()).toBeNull();
    localStorage.setItem('noteviewer.scroll', '"nope"');
    expect(loadScroll('a.md', 'read')).toBeUndefined();
  });

  it('keeps scroll positions per note and per view', () => {
    saveScroll('a.md', 'read', 812.4);
    saveScroll('a.md', 'edit', 40);
    expect(loadScroll('a.md', 'read')).toBe(812);
    expect(loadScroll('a.md', 'edit')).toBe(40);
    expect(loadScroll('b.md', 'read')).toBeUndefined();
  });

  it('drops the oldest scroll positions past the cap', () => {
    for (let i = 0; i < 105; i++) saveScroll(`n${i}.md`, 'read', i);
    expect(loadScroll('n0.md', 'read')).toBeUndefined();
    expect(loadScroll('n4.md', 'read')).toBeUndefined();
    expect(loadScroll('n5.md', 'read')).toBe(5);
    expect(loadScroll('n104.md', 'read')).toBe(104);
  });
});
