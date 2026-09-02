import fs from 'node:fs/promises';
import path from 'node:path';
import MiniSearch from 'minisearch';
import type { GraphData, GraphEdge, GraphNode, NoteMeta, SearchResult } from '@noteviewer/shared';
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

  /**
   * Whole-vault link graph. Every note is a node; every wikilink becomes a
   * directed edge from the note to its resolved target. Links that resolve
   * to nothing on disk become `unresolved` nodes keyed by the cleaned link
   * text, matching Obsidian's greyed-out "phantom" nodes. Self-links and
   * duplicate links within one note are collapsed.
   */
  graph(): GraphData {
    const nodes = new Map<string, GraphNode>();
    for (const meta of this.notes.values()) {
      nodes.set(meta.path, {
        id: meta.path,
        title: meta.title,
        tags: meta.tags,
        unresolved: false,
        inbound: 0,
        outbound: 0,
      });
    }
    const edges: GraphEdge[] = [];
    const paths = [...this.notes.keys()].sort();
    for (const source of paths) {
      const meta = this.notes.get(source)!;
      const seen = new Set<string>();
      for (const raw of meta.links) {
        const resolved = this.resolveLink(raw);
        let target: string;
        if (resolved) {
          target = resolved;
        } else {
          const clean = raw.split('#')[0]!.split('|')[0]!.trim();
          if (!clean) continue;
          target = clean;
          if (!nodes.has(target)) {
            nodes.set(target, {
              id: target,
              title: clean.replace(/\.md$/i, ''),
              tags: [],
              unresolved: true,
              inbound: 0,
              outbound: 0,
            });
          }
        }
        if (target === source || seen.has(target)) continue;
        seen.add(target);
        edges.push({ source, target });
        nodes.get(source)!.outbound += 1;
        nodes.get(target)!.inbound += 1;
      }
    }
    return { nodes: [...nodes.values()], edges };
  }

  search(q: string): SearchResult[] {
    if (!q.trim()) return [];
    return this.mini
      .search(q)
      .slice(0, 50)
      .map((r) => ({ path: r.id as string, title: r['title'] as string, score: r.score }));
  }
}
