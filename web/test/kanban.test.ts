import { describe, expect, it } from 'vitest';
import { isKanbanNote, parseKanban, serializeKanban } from '../src/kanban';

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
