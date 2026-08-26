import { describe, expect, it } from 'vitest';
import { parseNote } from '../src/vault/parse.js';

describe('parseNote', () => {
  it('extracts wikilinks, stripping aliases and headings', () => {
    const p = parseNote('See [[Other Note]], [[Folder/Deep]], [[X|alias]], [[Y#section]].');
    expect(p.links).toEqual(['Other Note', 'Folder/Deep', 'X', 'Y']);
  });

  it('merges frontmatter and inline tags', () => {
    const p = parseNote('---\ntags: [work, home]\n---\nBody with #inline and #nested/tag.');
    expect(p.tags.sort()).toEqual(['home', 'inline', 'nested/tag', 'work']);
  });

  it('collects headings and uses first h1 as title', () => {
    const p = parseNote('# My Title\n\n## Section A\n\ntext\n\n### Sub');
    expect(p.title).toBe('My Title');
    expect(p.headings).toEqual([
      { level: 1, text: 'My Title' },
      { level: 2, text: 'Section A' },
      { level: 3, text: 'Sub' },
    ]);
  });

  it('survives invalid frontmatter YAML', () => {
    const p = parseNote('---\n:{ not yaml ::\n---\n# Ok');
    expect(p.title).toBe('Ok');
  });

  it('returns empty results for an empty note', () => {
    expect(parseNote('')).toEqual({ title: null, tags: [], links: [], headings: [] });
  });

  it('handles CRLF line endings correctly', () => {
    const p = parseNote('# Title\r\n\r\n## Section\r\ntext');
    expect(p.title).toBe('Title');
    expect(p.headings).toEqual([
      { level: 1, text: 'Title' },
      { level: 2, text: 'Section' },
    ]);
  });
});
