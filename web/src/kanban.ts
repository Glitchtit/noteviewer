export interface KanbanItem {
  text: string;
  done: boolean;
  // A plain `- text` list item (no checkbox), kept as a card so it round-trips
  // instead of being silently dropped; serialized back without `[ ]`/`[x]`.
  plain?: boolean;
}
export interface KanbanColumn {
  title: string;
  items: KanbanItem[];
  // Unrecognized non-blank lines within this column (not a heading, task
  // item, or plain list item), kept verbatim and re-emitted after the
  // column's items so they aren't silently dropped on the first board write.
  extras?: string[];
}
export interface KanbanDoc {
  frontmatter: string;
  columns: KanbanColumn[];
  trailer: string;
  // Non-blank lines that appear after the frontmatter but before the first
  // `##` column heading, kept verbatim and re-emitted in the same spot.
  preamble?: string[];
}

const FM = /^---\n[\s\S]*?\n---\n?/;

export function isKanbanNote(content: string): boolean {
  const m = FM.exec(content);
  return !!m && m[0].includes('kanban-plugin');
}

export function parseKanban(content: string): KanbanDoc {
  const fmMatch = FM.exec(content);
  const frontmatter = fmMatch ? fmMatch[0].trimEnd() : '';
  let body = content.slice(fmMatch ? fmMatch[0].length : 0);
  let trailer = '';
  const trailerIdx = body.indexOf('%% kanban:settings');
  if (trailerIdx >= 0) {
    trailer = body.slice(trailerIdx).trimEnd();
    body = body.slice(0, trailerIdx);
  }
  const columns: KanbanColumn[] = [];
  const preamble: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      columns.push({ title: h[1]!.trim(), items: [] });
      continue;
    }
    if (!columns.length) {
      preamble.push(line);
      continue;
    }
    const col = columns[columns.length - 1]!;
    const item = /^-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (item) {
      col.items.push({ text: item[2]!.trim(), done: item[1]!.toLowerCase() === 'x' });
      continue;
    }
    const plain = /^-\s+(.*)$/.exec(line);
    if (plain) {
      col.items.push({ text: plain[1]!.trim(), done: false, plain: true });
      continue;
    }
    (col.extras ??= []).push(line);
  }
  return { frontmatter, columns, trailer, preamble };
}

export function moveCardIn(
  doc: KanbanDoc,
  from: { col: number; item: number },
  to: { col: number; item: number },
): KanbanDoc {
  const next: KanbanDoc = { ...doc, columns: doc.columns.map((c) => ({ ...c, items: [...c.items] })) };
  const [card] = next.columns[from.col]!.items.splice(from.item, 1);
  const targetItems = next.columns[to.col]!.items;
  // Removing the card from its source column shifts every later index in
  // that same column down by one, so a same-column downward drop must
  // target one slot earlier than the pre-removal drop index.
  const rawInsertAt = from.col === to.col && from.item < to.item ? to.item - 1 : to.item;
  const insertAt = Math.max(0, Math.min(rawInsertAt, targetItems.length));
  targetItems.splice(insertAt, 0, card!);
  return next;
}

export function serializeKanban(doc: KanbanDoc): string {
  const cols = doc.columns.map((c) => {
    const items = c.items.map((i) => (i.plain ? `- ${i.text}` : `- [${i.done ? 'x' : ' '}] ${i.text}`));
    const body = [...items, ...(c.extras ?? [])].join('\n');
    return body ? `## ${c.title}\n\n${body}` : `## ${c.title}`;
  });
  const parts: string[] = [];
  if (doc.frontmatter) parts.push(doc.frontmatter);
  if (doc.preamble?.length) parts.push(doc.preamble.join('\n'));
  parts.push(cols.join('\n\n'));
  if (doc.trailer) parts.push(doc.trailer);
  return `${parts.join('\n\n')}\n`;
}
