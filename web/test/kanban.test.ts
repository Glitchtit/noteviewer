import { describe, expect, it } from 'vitest';
import { isKanbanNote, type KanbanDoc, moveCardIn, parseKanban, serializeKanban } from '../src/kanban';

const FM = '---\n\nkanban-plugin: board\n\n---\n\n';
const doc = `${FM}## Todo\n\n- [ ] task one\n- [x] task two\n\n## Done\n\n- [x] shipped\n\n%% kanban:settings\n\`\`\`\n{"kanban-plugin":"board"}\n\`\`\`\n%%`;

describe('kanban', () => {
  it('detects kanban notes', () => {
    expect(isKanbanNote(doc)).toBe(true);
    expect(isKanbanNote('# normal note')).toBe(false);
  });

  it('parses columns, items, and preserves the settings trailer', () => {
    const p = parseKanban(doc);
    expect(p.columns.map((c) => c.title)).toEqual(['Todo', 'Done']);
    expect(p.columns[0]!.items).toEqual([
      { text: 'task one', done: false },
      { text: 'task two', done: true },
    ]);
    expect(p.trailer).toContain('kanban:settings');
  });

  it('round-trips stably', () => {
    const p = parseKanban(doc);
    const out = serializeKanban(p);
    expect(parseKanban(out)).toEqual(p);
    expect(out).toContain('kanban-plugin');
    expect(out).toContain('%% kanban:settings');
  });
});

function itemsDoc(items: string[]): KanbanDoc {
  return {
    frontmatter: '---\nkanban-plugin: board\n---',
    trailer: '',
    columns: [{ title: 'Col', items: items.map((text) => ({ text, done: false })) }],
  };
}

function texts(d: KanbanDoc, col = 0): string[] {
  return d.columns[col]!.items.map((i) => i.text);
}

describe('moveCardIn', () => {
  it('downward same-column: card lands before the drop target', () => {
    // A(0) dropped onto C(2) in [A,B,C,D] must land immediately before C,
    // not after it — splice-then-insert-at-raw-index overshoots by one.
    const doc = itemsDoc(['A', 'B', 'C', 'D']);
    const next = moveCardIn(doc, { col: 0, item: 0 }, { col: 0, item: 2 });
    expect(texts(next)).toEqual(['B', 'A', 'C', 'D']);
  });

  it('upward same-column: card lands before the drop target', () => {
    const doc = itemsDoc(['A', 'B', 'C', 'D']);
    const next = moveCardIn(doc, { col: 0, item: 2 }, { col: 0, item: 0 });
    expect(texts(next)).toEqual(['C', 'A', 'B', 'D']);
  });

  it('cross-column: card moves at the given index in the target column', () => {
    const doc: KanbanDoc = {
      frontmatter: '---\nkanban-plugin: board\n---',
      trailer: '',
      columns: [
        { title: 'Todo', items: [{ text: 'A', done: false }, { text: 'B', done: false }] },
        { title: 'Done', items: [{ text: 'X', done: true }, { text: 'Y', done: true }] },
      ],
    };
    const next = moveCardIn(doc, { col: 0, item: 0 }, { col: 1, item: 1 });
    expect(texts(next, 0)).toEqual(['B']);
    expect(texts(next, 1)).toEqual(['X', 'A', 'Y']);
  });

  it('drop at end (toIndex === items.length) appends within the same column', () => {
    const doc = itemsDoc(['A', 'B', 'C']);
    const next = moveCardIn(doc, { col: 0, item: 0 }, { col: 0, item: 3 });
    expect(texts(next)).toEqual(['B', 'C', 'A']);
  });

  it('drop at end in a different column appends there', () => {
    const doc: KanbanDoc = {
      frontmatter: '---\nkanban-plugin: board\n---',
      trailer: '',
      columns: [
        { title: 'Todo', items: [{ text: 'A', done: false }] },
        { title: 'Done', items: [{ text: 'X', done: true }] },
      ],
    };
    const next = moveCardIn(doc, { col: 0, item: 0 }, { col: 1, item: 1 });
    expect(texts(next, 0)).toEqual([]);
    expect(texts(next, 1)).toEqual(['X', 'A']);
  });
});
