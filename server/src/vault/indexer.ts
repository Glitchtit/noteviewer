import fs from 'node:fs/promises';
import path from 'node:path';
import MiniSearch from 'minisearch';
import type { NoteMeta, SearchResult } from '@noteviewer/shared';
import { isHiddenName, readNote } from './files.js';
import { parseNote } from './parse.js';

export class VaultIndex {
  readonly root: string;
  private notes = new Map<string, NoteMeta>();
  private mini: MiniSearch<{ path: string; title: string; content: string }>;

  constructor(root: string) {
    this.root = root;
    this.mini = new MiniSearch({
      idField: 'path',
      fields: ['title', 'content'],
      storeFields: ['title'],
      searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 2 } },
    });
  }

  async init(): Promise<void> {
    for (const rel of await this.listMarkdown()) await this.updateNote(rel);
  }

  private async listMarkdown(relDir = ''): Promise<string[]> {
    const absDir = path.join(this.root, relDir);
    const out: string[] = [];
    for (const e of await fs.readdir(absDir, { withFileTypes: true })) {
      if (isHiddenName(e.name)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await this.listMarkdown(rel)));
      else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
    }
    return out;
  }

  async updateNote(rel: string): Promise<void> {
    const { content, mtimeMs, hash } = await readNote(this.root, rel);
    const parsed = parseNote(content);
    const title = parsed.title ?? path.posix.basename(rel, '.md');
    if (this.notes.has(rel)) this.mini.discard(rel);
    this.mini.add({ path: rel, title, content });
    this.notes.set(rel, {
      path: rel,
      title,
      tags: parsed.tags,
      links: parsed.links,
      headings: parsed.headings,
      mtimeMs,
      hash,
    });
  }

  removeNote(rel: string): void {
    if (this.notes.delete(rel)) this.mini.discard(rel);
  }

  getMeta(rel: string): NoteMeta | undefined {
    return this.notes.get(rel);
  }

  allNotes(): NoteMeta[] {
    return [...this.notes.values()];
  }

  resolveLink(target: string): string | undefined {
    const clean = target.split('#')[0]!.split('|')[0]!.trim();
    if (!clean) return undefined;
    const withExt = clean.toLowerCase().endsWith('.md') ? clean : `${clean}.md`;
    if (this.notes.has(withExt)) return withExt;
    const lower = withExt.toLowerCase();
    const matches = [...this.notes.keys()].filter(
      (p) => p.toLowerCase() === lower || p.toLowerCase().endsWith(`/${lower}`),
    );
    matches.sort((a, b) => a.length - b.length || a.localeCompare(b));
    return matches[0];
  }

  backlinksOf(rel: string): string[] {
    const out: string[] = [];
    for (const meta of this.notes.values()) {
      if (meta.path === rel) continue;
      if (meta.links.some((l) => this.resolveLink(l) === rel)) out.push(meta.path);
    }
    return out.sort();
  }

  search(q: string): SearchResult[] {
    if (!q.trim()) return [];
    return this.mini
      .search(q)
      .slice(0, 50)
      .map((r) => ({ path: r.id as string, title: r['title'] as string, score: r.score }));
  }
}
