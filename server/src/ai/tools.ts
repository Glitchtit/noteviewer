/**
 * The agent's vault tools. Every path is vault-relative and confined to the
 * vault; hidden segments (.obsidian, .trash, .git, …) are unreachable. All
 * mutations go through vault/ops.ts so the index, live updates and share
 * links stay consistent with edits made in the UI.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BetaTool,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ChangeRecord, TreeNode } from '@noteviewer/shared';
import { buildTree, isHiddenName, readNote } from '../vault/files.js';
import { PathError, resolveVaultPath } from '../vault/paths.js';
import { deleteNote, exists, renameNote, writeNote, type VaultCtx } from '../vault/ops.js';

export type ToolContent = NonNullable<BetaToolResultBlockParam['content']>;

export interface ToolOutcome {
  content: ToolContent;
  isError: boolean;
  /** one line for the UI, e.g. "Edited a.md (+1 −1)" */
  summary: string;
  /** longer UI detail (diff, listing) */
  detail?: string;
  change?: Omit<ChangeRecord, 'id'>;
}

const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;

function def(name: string, description: string, properties: Record<string, object>, required: string[]): BetaTool {
  return {
    name,
    description,
    eager_input_streaming: true,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
  };
}

export const TOOL_DEFS: BetaTool[] = [
  def(
    'list',
    'List folders and files in the vault as an indented tree. Folders end with "/".',
    {
      path: { ...str, description: 'Folder to list, vault-relative. Omit for the vault root.' },
      depth: { ...int, description: 'How many folder levels to show (default 2).' },
    },
    [],
  ),
  def(
    'read',
    'Read a file. Notes and text files are returned with line numbers ("     N\\tline"); images and PDFs are returned for you to view. Reading a note is required before editing or overwriting it.',
    {
      path: { ...str, description: 'Vault-relative file path, e.g. "Projects/Plan.md".' },
      offset: { ...int, description: 'First line to return (1-based).' },
      limit: { ...int, description: 'Maximum number of lines (default 2000).' },
    },
    ['path'],
  ),
  def(
    'search',
    'Full-text search over note titles and contents (fuzzy, prefix). Returns matching note paths, best first.',
    { query: str, limit: { ...int, description: 'Maximum results (default 20).' } },
    ['query'],
  ),
  def(
    'grep',
    'Search note contents with a JavaScript regular expression. Returns "path:line: text" matches.',
    {
      pattern: { ...str, description: 'JavaScript regular expression.' },
      path: { ...str, description: 'Only search within this folder.' },
      glob: { ...str, description: 'Only search files whose vault path matches, e.g. "Daily/*.md" or "**/*.md".' },
      ignore_case: bool,
      limit: { ...int, description: 'Maximum matches (default 200).' },
    },
    ['pattern'],
  ),
  def(
    'links',
    "Show a note's outgoing [[links]] (resolved or not), backlinks, tags and headings.",
    { path: str },
    ['path'],
  ),
  def(
    'write',
    'Create a note, or replace an existing note completely. Prefer `edit` for changes to existing notes. Overwriting requires that you read the note first. Only .md files.',
    { path: str, content: { ...str, description: 'The full new file content.' } },
    ['path', 'content'],
  ),
  def(
    'edit',
    'Replace exact text in a note. old_string must match the file exactly (including whitespace) and occur exactly once unless replace_all is true. Read the note first.',
    { path: str, old_string: str, new_string: str, replace_all: bool },
    ['path', 'old_string', 'new_string'],
  ),
  def(
    'move',
    'Rename or move a note. Wikilinks to it elsewhere in the vault are updated. Fails if the target exists.',
    { from: str, to: str },
    ['from', 'to'],
  ),
  def('delete', "Delete a note (moved to the vault's .trash, recoverable).", { path: str }, ['path']),
];

const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.canvas', '.csv', '.tsv', '.yaml', '.yml', '.base']);
const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_BINARY = 20 * 1024 * 1024;
const MAX_LINE = 2000;

class ToolError extends Error {}

function fail(message: string, summary = message): ToolOutcome {
  return { content: message, isError: true, summary };
}

function getString(input: Record<string, unknown>, key: string, required: true): string;
function getString(input: Record<string, unknown>, key: string, required: false): string | undefined;
function getString(input: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`Invalid input: "${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`Invalid input: "${key}" must be a string`);
  return v;
}

function getInt(input: Record<string, unknown>, key: string, fallback: number, min: number): number {
  const v = input[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new ToolError(`Invalid input: "${key}" must be an integer ≥ ${min}`);
  }
  return v;
}

function getBool(input: Record<string, unknown>, key: string): boolean {
  const v = input[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new ToolError(`Invalid input: "${key}" must be a boolean`);
  return v;
}

/** Normalise and validate a vault-relative path; '' is the root. */
function cleanPath(raw: string, root: string, opts: { allowRoot?: boolean } = {}): string {
  if (raw.includes('\0')) throw new ToolError('Invalid path');
  let p = raw.trim().replace(/\\/g, '/');
  if (p.startsWith('/')) throw new ToolError(`Path must be vault-relative, not absolute: ${raw}`);
  p = p.replace(/^\.\//, '').replace(/\/+$/, '');
  const norm = path.posix.normalize(p || '.');
  const rel = norm === '.' ? '' : norm;
  if (!rel && !opts.allowRoot) throw new ToolError('A file path is required');
  if (rel.split('/').some((seg) => seg === '..')) throw new ToolError(`Path escapes the vault: ${raw}`);
  if (rel && rel.split('/').some(isHiddenName)) throw new ToolError(`Hidden paths are not accessible: ${raw}`);
  try {
    resolveVaultPath(root, rel);
  } catch (err) {
    if (err instanceof PathError) throw new ToolError(err.message);
    throw err;
  }
  return rel;
}

function requireMd(rel: string): void {
  if (!rel.toLowerCase().endsWith('.md')) throw new ToolError(`Only Markdown notes (.md) can be changed: ${rel}`);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // a bare file pattern ("*.md") matches in any folder
  return new RegExp(glob.includes('/') ? `^${re}$` : `(^|/)${re}$`);
}

/** Line-level diff (LCS on the changed middle) rendered unified-style with 2 lines of context. */
export function lineDiff(before: string, after: string): { added: number; removed: number; diff: string } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  if (am.length * bm.length > 4_000_000) {
    for (const s of am) ops.push({ t: '-', s });
    for (const s of bm) ops.push({ t: '+', s });
  } else {
    const n = am.length;
    const m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: ' ', s: am[i]! });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: '-', s: am[i++]! });
      else ops.push({ t: '+', s: bm[j++]! });
    }
    while (i < n) ops.push({ t: '-', s: am[i++]! });
    while (j < m) ops.push({ t: '+', s: bm[j++]! });
  }
  const added = ops.filter((o) => o.t === '+').length;
  const removed = ops.filter((o) => o.t === '-').length;
  const all = [
    ...a.slice(Math.max(0, pre - 2), pre).map((s) => ({ t: ' ' as const, s })),
    ...ops,
    ...a.slice(a.length - suf, Math.min(a.length, a.length - suf + 2)).map((s) => ({ t: ' ' as const, s })),
  ];
  // collapse long unchanged runs inside the middle
  const out: string[] = [];
  let run: string[] = [];
  const flushRun = () => {
    if (run.length > 5) out.push(...run.slice(0, 2), ' …', ...run.slice(-2));
    else out.push(...run);
    run = [];
  };
  for (const o of all) {
    if (o.t === ' ') run.push(` ${o.s}`);
    else {
      flushRun();
      out.push(`${o.t}${o.s}`);
    }
  }
  flushRun();
  const capped = out.length > 400 ? [...out.slice(0, 400), `… ${out.length - 400} more diff lines`] : out;
  return { added, removed, diff: capped.join('\n') };
}

export class VaultTools {
  constructor(
    private ctx: VaultCtx,
    /** read-before-write ledger: path → hash the agent last saw; mutated in place */
    private seen: Record<string, string>,
  ) {}

  async run(name: string, rawInput: unknown): Promise<ToolOutcome> {
    if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
      return fail('Invalid input: expected an object');
    }
    const input = rawInput as Record<string, unknown>;
    try {
      switch (name) {
        case 'list':
          return await this.list(input);
        case 'read':
          return await this.read(input);
        case 'search':
          return this.search(input);
        case 'grep':
          return await this.grep(input);
        case 'links':
          return this.links(input);
        case 'write':
          return await this.write(input);
        case 'edit':
          return await this.edit(input);
        case 'move':
          return await this.move(input);
        case 'delete':
          return await this.delete(input);
        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof ToolError) return fail(err.message);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return fail('File not found');
      if (code === 'EISDIR') return fail('That path is a folder; use `list`');
      return fail(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async list(input: Record<string, unknown>): Promise<ToolOutcome> {
    const rel = cleanPath(getString(input, 'path', false) ?? '', this.ctx.vaultRoot, { allowRoot: true });
    const depth = getInt(input, 'depth', 2, 1);
    const tree = await buildTree(this.ctx.vaultRoot);
    let node: TreeNode | undefined = tree;
    if (rel) {
      for (const seg of rel.split('/')) node = node?.children?.find((c) => c.name === seg);
      if (!node || node.type !== 'folder') throw new ToolError(`Folder not found: ${rel}`);
    }
    const lines: string[] = [];
    const walk = (n: TreeNode, level: number) => {
      for (const c of n.children ?? []) {
        if (lines.length >= 2000) return;
        lines.push(`${'  '.repeat(level)}${c.name}${c.type === 'folder' ? '/' : ''}`);
        if (c.type === 'folder' && level + 1 < depth) walk(c, level + 1);
      }
    };
    walk(node, 0);
    const body = lines.length ? lines.join('\n') : '(empty)';
    return { content: body, isError: false, summary: `Listed ${rel || 'vault root'}`, detail: body };
  }

  private async read(input: Record<string, unknown>): Promise<ToolOutcome> {
    const rel = cleanPath(getString(input, 'path', true), this.ctx.vaultRoot);
    const ext = path.posix.extname(rel).toLowerCase();
    const abs = resolveVaultPath(this.ctx.vaultRoot, rel);
    const imageType = IMAGE_TYPES[ext];
    if (imageType || ext === '.pdf') {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_BINARY) throw new ToolError(`File too large to view (${Math.round(stat.size / 1e6)} MB)`);
      const data = (await fs.readFile(abs)).toString('base64');
      const content: ToolContent = imageType
        ? [{ type: 'image', source: { type: 'base64', media_type: imageType, data } }]
        : [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }];
      return { content, isError: false, summary: `Viewed ${rel}` };
    }
    if (!TEXT_EXTS.has(ext)) throw new ToolError(`Cannot read binary file type "${ext || '(none)'}"`);
    const file = await readNote(this.ctx.vaultRoot, rel);
    if (ext === '.md') this.seen[rel] = file.hash;
    const all = file.content.split('\n');
    const offset = getInt(input, 'offset', 1, 1);
    const limit = getInt(input, 'limit', 2000, 1);
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((line, i) => {
        const shown = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [line truncated]` : line;
        return `${String(offset + i).padStart(6)}\t${shown}`;
      })
      .join('\n');
    const rest = all.length - (offset - 1 + slice.length);
    const body =
      (file.content === '' ? '(empty file)' : numbered || '(no lines in that range)') +
      (rest > 0 ? `\n… (${rest} more lines; use offset to read further)` : '');
    return { content: body, isError: false, summary: `Read ${rel} (${plural(all.length, 'line')})` };
  }

  private search(input: Record<string, unknown>): ToolOutcome {
    const query = getString(input, 'query', true);
    const limit = getInt(input, 'limit', 20, 1);
    const hits = this.ctx.index.search(query).slice(0, limit);
    const body = hits.length
      ? hits.map((h) => `${h.path}${h.title && h.title !== path.posix.basename(h.path, '.md') ? ` — ${h.title}` : ''}`).join('\n')
      : 'No matches.';
    return { content: body, isError: false, summary: `Searched "${query}" (${plural(hits.length, 'hit')})`, detail: body };
  }

  private async grep(input: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = getString(input, 'pattern', true);
    const folder = cleanPath(getString(input, 'path', false) ?? '', this.ctx.vaultRoot, { allowRoot: true });
    const glob = getString(input, 'glob', false);
    const limit = getInt(input, 'limit', 200, 1);
    let re: RegExp;
    try {
      re = new RegExp(pattern, getBool(input, 'ignore_case') ? 'i' : '');
    } catch (err) {
      throw new ToolError(`Invalid regular expression: ${err instanceof Error ? err.message : pattern}`);
    }
    const globRe = glob ? globToRegex(glob) : undefined;
    const paths = this.ctx.index
      .allNotes()
      .map((n) => n.path)
      .filter((p) => (!folder || p.startsWith(`${folder}/`)) && (!globRe || globRe.test(p)))
      .sort();
    const matches: string[] = [];
    let truncated = false;
    outer: for (const p of paths) {
      let content: string;
      try {
        content = (await readNote(this.ctx.vaultRoot, p)).content;
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          if (matches.length >= limit) {
            truncated = true;
            break outer;
          }
          const line = lines[i]!.length > 300 ? `${lines[i]!.slice(0, 300)}…` : lines[i]!;
          matches.push(`${p}:${i + 1}: ${line}`);
        }
      }
    }
    const body = matches.length ? matches.join('\n') + (truncated ? `\n… (limit ${limit} reached)` : '') : 'No matches.';
    return { content: body, isError: false, summary: `Grep /${pattern}/ (${plural(matches.length, 'match')})`, detail: body };
  }

  private links(input: Record<string, unknown>): ToolOutcome {
    const rel = cleanPath(getString(input, 'path', true), this.ctx.vaultRoot);
    const meta = this.ctx.index.getMeta(rel);
    if (!meta) throw new ToolError(`Note not found: ${rel}`);
    const outgoing = [...new Set(meta.links)].map((l) => {
      const r = this.ctx.index.resolveLink(l);
      return r ? `[[${l}]] → ${r}` : `[[${l}]] → (no such note)`;
    });
    const backlinks = this.ctx.index.backlinksOf(rel);
    const body = [
      `Outgoing links:\n${outgoing.length ? outgoing.map((l) => `- ${l}`).join('\n') : '(none)'}`,
      `Backlinks:\n${backlinks.length ? backlinks.map((b) => `- ${b}`).join('\n') : '(none)'}`,
      `Tags: ${meta.tags.length ? meta.tags.map((t) => `#${t}`).join(' ') : '(none)'}`,
      `Headings:\n${meta.headings.length ? meta.headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n') : '(none)'}`,
    ].join('\n\n');
    return { content: body, isError: false, summary: `Links of ${rel}`, detail: body };
  }

  /** Current content of an existing note the agent is allowed to change. */
  private async readForChange(rel: string): Promise<{ content: string; hash: string }> {
    const file = await readNote(this.ctx.vaultRoot, rel);
    if (this.seen[rel] !== file.hash) {
      throw new ToolError(
        this.seen[rel] === undefined
          ? `You have not read ${rel} yet. Read it before changing it.`
          : `${rel} has changed since you last read it. Read it again before changing it.`,
      );
    }
    return file;
  }

  private async commit(rel: string, content: string, baseHash: string | undefined) {
    const res = await writeNote(this.ctx, rel, content, baseHash);
    if (res.conflict) throw new ToolError(`${rel} changed while writing. Read it again and retry.`);
    this.seen[rel] = res.hash;
    return res.hash;
  }

  private async write(input: Record<string, unknown>): Promise<ToolOutcome> {
    const rel = cleanPath(getString(input, 'path', true), this.ctx.vaultRoot);
    requireMd(rel);
    const content = getString(input, 'content', true);
    if (!(await exists(this.ctx, rel))) {
      const hash = await this.commit(rel, content, undefined);
      const d = lineDiff('', content);
      return {
        content: `Created ${rel}`,
        isError: false,
        summary: `Created ${rel} (+${d.added})`,
        detail: d.diff,
        change: { op: 'create', path: rel, before: null, afterHash: hash, added: d.added, removed: 0 },
      };
    }
    const before = await this.readForChange(rel);
    const hash = await this.commit(rel, content, before.hash);
    const d = lineDiff(before.content, content);
    return {
      content: `Wrote ${rel}`,
      isError: false,
      summary: `Wrote ${rel} (+${d.added} −${d.removed})`,
      detail: d.diff,
      change: { op: 'write', path: rel, before: before.content, afterHash: hash, added: d.added, removed: d.removed },
    };
  }

  private async edit(input: Record<string, unknown>): Promise<ToolOutcome> {
    const rel = cleanPath(getString(input, 'path', true), this.ctx.vaultRoot);
    requireMd(rel);
    const oldStr = getString(input, 'old_string', true);
    const newStr = getString(input, 'new_string', true);
    const replaceAll = getBool(input, 'replace_all');
    if (oldStr === '') throw new ToolError('old_string must not be empty; use `write` to create a note');
    if (oldStr === newStr) throw new ToolError('old_string and new_string are identical');
    const before = await this.readForChange(rel);
    const count = before.content.split(oldStr).length - 1;
    if (count === 0) throw new ToolError(`old_string not found in ${rel}`);
    if (count > 1 && !replaceAll) {
      throw new ToolError(`old_string occurs ${count} times in ${rel}; include more surrounding text or set replace_all`);
    }
    const updated = replaceAll ? before.content.split(oldStr).join(newStr) : before.content.replace(oldStr, () => newStr);
    const hash = await this.commit(rel, updated, before.hash);
    const d = lineDiff(before.content, updated);
    return {
      content: `Edited ${rel}${replaceAll ? ` (${plural(count, 'replacement')})` : ''}`,
      isError: false,
      summary: `Edited ${rel} (+${d.added} −${d.removed})`,
      detail: d.diff,
      change: { op: 'edit', path: rel, before: before.content, afterHash: hash, added: d.added, removed: d.removed },
    };
  }

  private async move(input: Record<string, unknown>): Promise<ToolOutcome> {
    const from = cleanPath(getString(input, 'from', true), this.ctx.vaultRoot);
    const to = cleanPath(getString(input, 'to', true), this.ctx.vaultRoot);
    requireMd(from);
    requireMd(to);
    if (from === to) throw new ToolError('from and to are the same');
    const file = await readNote(this.ctx.vaultRoot, from);
    const res = await renameNote(this.ctx, from, to);
    if (!res) throw new ToolError(`${to} already exists`);
    if (this.seen[from] !== undefined) {
      this.seen[to] = this.seen[from]!;
      delete this.seen[from];
    }
    const note = res.rewritten.length ? ` (updated links in ${plural(res.rewritten.length, 'note')})` : '';
    return {
      content: `Moved ${from} → ${to}${note}`,
      isError: false,
      summary: `Moved ${from} → ${to}${note}`,
      detail: res.rewritten.length ? `Links updated in:\n${res.rewritten.join('\n')}` : undefined,
      change: {
        op: 'move',
        path: to,
        from,
        before: null,
        afterHash: file.hash,
        rewritten: res.rewritten,
        added: 0,
        removed: 0,
      },
    };
  }

  private async delete(input: Record<string, unknown>): Promise<ToolOutcome> {
    const rel = cleanPath(getString(input, 'path', true), this.ctx.vaultRoot);
    requireMd(rel);
    const file = await readNote(this.ctx.vaultRoot, rel);
    const trashedTo = await deleteNote(this.ctx, rel);
    delete this.seen[rel];
    const lines = file.content === '' ? 0 : file.content.split('\n').length;
    return {
      content: `Deleted ${rel} (moved to ${trashedTo})`,
      isError: false,
      summary: `Deleted ${rel}`,
      change: { op: 'delete', path: rel, before: file.content, afterHash: null, trashedTo, added: 0, removed: lines },
    };
  }
}

