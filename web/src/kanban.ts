export interface KanbanItem {
  text: string;
  done: boolean;
}
export interface KanbanColumn {
  title: string;
  items: KanbanItem[];
}
export interface KanbanDoc {
  frontmatter: string;
  columns: KanbanColumn[];
  trailer: string;
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
  for (const line of body.split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      columns.push({ title: h[1]!.trim(), items: [] });
      continue;
    }
    const item = /^-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (item && columns.length) {
      columns[columns.length - 1]!.items.push({ text: item[2]!.trim(), done: item[1]!.toLowerCase() === 'x' });
    }
  }
  return { frontmatter, columns, trailer };
}

export function serializeKanban(doc: KanbanDoc): string {
  const cols = doc.columns.map((c) => {
    const items = c.items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n');
    return items ? `## ${c.title}\n\n${items}` : `## ${c.title}`;
  });
  const parts: string[] = [];
  if (doc.frontmatter) parts.push(doc.frontmatter);
  parts.push(cols.join('\n\n'));
  if (doc.trailer) parts.push(doc.trailer);
  return `${parts.join('\n\n')}\n`;
}
