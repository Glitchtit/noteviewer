# Noteviewer Server Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the noteviewer backend — a Fastify API over an Obsidian vault folder with in-memory link/search indexes, a change watcher with SSE, conflict-guarded atomic writes, and a Docker image published to GHCR.

**Architecture:** npm-workspaces monorepo (`shared/`, `server/`, `web/` stub). No database — the vault folder is the store; `VaultIndex` holds links/tags/search in memory and is updated by a chokidar watcher. Fastify serves `/api/*` plus the web build. Production runtime is `tsx` (no server build step); only the web app gets a Vite build (Plan 2).

**Tech Stack:** Node 22, TypeScript (strict, ESM), Fastify 5, chokidar 4, gray-matter, MiniSearch 7, Vitest 3, tsx.

**Spec:** `docs/superpowers/specs/2026-08-26-noteviewer-design.md`

## Global Constraints

- Node >= 22, `"type": "module"` everywhere, TypeScript `strict: true`.
- `shared/` contains **types only** and is imported with `import type { ... } from '@noteviewer/shared'` — value imports from shared are forbidden (keeps tsx/vitest resolution trivial).
- Vault-relative paths always use `/` separators, never `\`, and never start with `/`.
- Hidden entries (name starts with `.`) and `node_modules` are invisible everywhere: tree, index, watcher, file serving. Deletes move files into `.trash/`, never unlink.
- All writes to the vault are atomic (temp file + rename in the same directory).
- No authentication anywhere in the app (Cloudflare Access owns auth).
- Env vars: `VAULT_PATH` (default `/vault`), `PORT` (default `8080`).
- Image name: `ghcr.io/glitchtit/noteviewer` (public). Git identity is already configured; never add AI co-author trailers.
- Run all tests from the repo root with `npx vitest run` (or a filtered path).
- Deliberate deviation from the spec's "all file ops get timeouts": inside the container the vault is a local bind mount, so server-side per-op timeouts are deferred; the client-side fetch timeout + "vault unreachable" banner (Plan 2) covers stall reporting. Revisit only if real stalls appear.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `shared/package.json`, `server/package.json`, `server/tsconfig.json`
- Create: `web/package.json`, `web/index.html` (placeholder workspace so npm doesn't error; Plan 2 replaces it)
- Test: `server/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a repo where `npm ci`/`npm install` works and `npx vitest run` executes tests under `server/test/`

- [ ] **Step 1: Write the (failing-by-absence) smoke test**

`server/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests', () => {
    const x: number = 2;
    expect(x + 2).toBe(4);
  });
});
```

- [ ] **Step 2: Run it to confirm the harness is missing**

Run: `npx vitest run`
Expected: fails — vitest not installed yet.

- [ ] **Step 3: Create the workspace files**

`package.json`:
```json
{
  "name": "noteviewer",
  "private": true,
  "type": "module",
  "workspaces": ["shared", "server", "web"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p server --noEmit",
    "dev": "npm run dev -w server"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
  },
});
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
```

`shared/package.json`:
```json
{
  "name": "@noteviewer/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`server/package.json`:
```json
{
  "name": "server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "tsx watch src/main.ts" },
  "dependencies": {
    "@fastify/static": "^8.0.0",
    "@noteviewer/shared": "*",
    "chokidar": "^4.0.0",
    "fastify": "^5.0.0",
    "gray-matter": "^4.0.3",
    "minisearch": "^7.0.0",
    "tsx": "^4.19.0"
  }
}
```

`server/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test", "../shared/src"]
}
```

`web/package.json` (stub until Plan 2 — build just copies the placeholder page):
```json
{
  "name": "web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "mkdir -p dist && cp index.html dist/" }
}
```

`web/index.html`:
```html
<!-- placeholder until Plan 2 -->
<h1>noteviewer API is running</h1>
```

Also create `shared/src/index.ts` containing only `export {};` for now (Task 2 fills it).

- [ ] **Step 4: Install and run the test**

Run: `npm install && npx vitest run`
Expected: 1 test PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold npm-workspaces monorepo with vitest"
```

---

### Task 2: Shared types

**Files:**
- Create: `shared/src/index.ts` (replace stub)

**Interfaces:**
- Consumes: nothing
- Produces (all later tasks import these with `import type`):
  - `TreeNode { name: string; path: string; type: 'folder' | 'note' | 'file'; children?: TreeNode[] }`
  - `Heading { level: number; text: string }`
  - `NoteMeta { path: string; title: string; tags: string[]; links: string[]; headings: Heading[]; mtimeMs: number; hash: string }`
  - `NoteResponse { meta: NoteMeta; backlinks: string[]; content: string }`
  - `SearchResult { path: string; title: string; score: number }`
  - `VaultEvent = { type: 'note-changed'; path: string } | { type: 'tree-changed' }`

- [ ] **Step 1: Write the types** (types-only task — the "test" is the typecheck)

`shared/src/index.ts`:
```ts
export interface TreeNode {
  name: string;
  /** vault-relative, '/'-separated, no leading '/' */
  path: string;
  type: 'folder' | 'note' | 'file';
  children?: TreeNode[];
}

export interface Heading {
  level: number;
  text: string;
}

export interface NoteMeta {
  path: string;
  title: string;
  tags: string[];
  /** raw wikilink targets as written, e.g. "Sub Note" or "folder/Sub Note" */
  links: string[];
  headings: Heading[];
  mtimeMs: number;
  /** sha256 hex of the file content — the conflict-guard token */
  hash: string;
}

export interface NoteResponse {
  meta: NoteMeta;
  backlinks: string[];
  content: string;
}

export interface SearchResult {
  path: string;
  title: string;
  score: number;
}

export type VaultEvent =
  | { type: 'note-changed'; path: string }
  | { type: 'tree-changed' };
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add shared/src/index.ts
git commit -m "feat: shared API types"
```

---

### Task 3: Safe vault path resolution

**Files:**
- Create: `server/src/vault/paths.ts`
- Test: `server/test/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class PathError extends Error`
  - `resolveVaultPath(root: string, rel: string): string` — absolute path, throws `PathError` if `rel` is absolute or escapes `root`

- [ ] **Step 1: Write the failing tests**

`server/test/paths.test.ts`:
```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathError, resolveVaultPath } from '../src/vault/paths.js';

const root = '/data/vault';

describe('resolveVaultPath', () => {
  it('resolves a nested relative path inside the root', () => {
    expect(resolveVaultPath(root, 'folder/note.md')).toBe(
      path.resolve(root, 'folder/note.md'),
    );
  });

  it('rejects absolute paths', () => {
    expect(() => resolveVaultPath(root, '/etc/passwd')).toThrow(PathError);
  });

  it('rejects .. escapes, including sneaky ones', () => {
    expect(() => resolveVaultPath(root, '../secret.md')).toThrow(PathError);
    expect(() => resolveVaultPath(root, 'a/../../secret.md')).toThrow(PathError);
  });

  it('allows the root itself via empty string', () => {
    expect(resolveVaultPath(root, '')).toBe(path.resolve(root));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/vault/paths.ts`:
```ts
import path from 'node:path';

export class PathError extends Error {}

export function resolveVaultPath(root: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new PathError(`absolute path not allowed: ${rel}`);
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new PathError(`path escapes vault: ${rel}`);
  }
  return abs;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/test/paths.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/vault/paths.ts server/test/paths.test.ts
git commit -m "feat: safe vault path resolution"
```

---

### Task 4: Note parsing (frontmatter, wikilinks, tags, headings)

**Files:**
- Create: `server/src/vault/parse.ts`
- Test: `server/test/parse.test.ts`

**Interfaces:**
- Consumes: `Heading` from shared
- Produces:
  - `ParsedNote { title: string | null; tags: string[]; links: string[]; headings: Heading[] }`
  - `parseNote(content: string): ParsedNote` — `title` is the first `# h1` or null; `links` are raw wikilink targets stripped of `#heading` and `|alias`; `tags` merge frontmatter `tags:` (string or list) and inline `#tag`s

Known v1 simplification (documented, accepted): `#` lines inside fenced code blocks are picked up as headings/tags. Do not fix here.

- [ ] **Step 1: Write the failing tests**

`server/test/parse.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/vault/parse.ts`:
```ts
import matter from 'gray-matter';
import type { Heading } from '@noteviewer/shared';

export interface ParsedNote {
  title: string | null;
  tags: string[];
  links: string[];
  headings: Heading[];
}

const WIKILINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const INLINE_TAG = /(?:^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;
const HEADING = /^(#{1,6})\s+(.+)$/;

export function parseNote(content: string): ParsedNote {
  let body = content;
  let fmData: Record<string, unknown> = {};
  try {
    const fm = matter(content);
    body = fm.content;
    fmData = fm.data as Record<string, unknown>;
  } catch {
    // invalid YAML frontmatter: treat whole file as body
  }

  const links: string[] = [];
  for (const m of body.matchAll(WIKILINK)) links.push(m[1]!.trim());

  const tags = new Set<string>();
  const fmTags = fmData['tags'];
  if (typeof fmTags === 'string') {
    for (const t of fmTags.split(',')) if (t.trim()) tags.add(t.trim());
  } else if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (typeof t === 'string' && t.trim()) tags.add(t.trim());
  }
  for (const m of body.matchAll(INLINE_TAG)) tags.add(m[1]!);

  const headings: Heading[] = [];
  for (const line of body.split('\n')) {
    const h = HEADING.exec(line);
    if (h) headings.push({ level: h[1]!.length, text: h[2]!.trim() });
  }

  return {
    title: headings.find((h) => h.level === 1)?.text ?? null,
    tags: [...tags],
    links,
    headings,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/test/parse.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/vault/parse.ts server/test/parse.test.ts
git commit -m "feat: markdown note parsing (links, tags, headings)"
```

---

### Task 5: File ops — read, atomic write, conflict guard, copy naming

**Files:**
- Create: `server/src/vault/files.ts`
- Create: `server/test/helpers.ts` (fixture-vault builder used by all later tests)
- Test: `server/test/files.test.ts`

**Interfaces:**
- Consumes: `resolveVaultPath` (Task 3)
- Produces:
  - `isHiddenName(name: string): boolean` — true for dotfiles and `node_modules`
  - `hashContent(content: string): string` — sha256 hex
  - `NoteFile { content: string; mtimeMs: number; hash: string }`
  - `readNote(root: string, rel: string): Promise<NoteFile>`
  - `WriteResult = { conflict: false; mtimeMs: number; hash: string } | { conflict: true; current: NoteFile }`
  - `writeNoteAtomic(root: string, rel: string, content: string, baseHash?: string): Promise<WriteResult>` — conflict iff `baseHash` given AND file exists AND its hash differs; missing file always writes (creates parent dirs)
  - `uniqueCopyPath(root: string, rel: string): Promise<string>` — `Note.md` → `Note-copy.md` → `Note-copy-2.md` …
  - helper: `makeVault(files: Record<string, string>): Promise<string>` in `helpers.ts`

- [ ] **Step 1: Write the test helper**

`server/test/helpers.ts`:
```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function makeVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'noteviewer-vault-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content, 'utf8');
  }
  return root;
}
```

- [ ] **Step 2: Write the failing tests**

`server/test/files.test.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hashContent,
  isHiddenName,
  readNote,
  uniqueCopyPath,
  writeNoteAtomic,
} from '../src/vault/files.js';
import { makeVault } from './helpers.js';

describe('files', () => {
  it('reads a note with hash and mtime', async () => {
    const root = await makeVault({ 'a.md': 'hello' });
    const n = await readNote(root, 'a.md');
    expect(n.content).toBe('hello');
    expect(n.hash).toBe(hashContent('hello'));
    expect(n.mtimeMs).toBeGreaterThan(0);
  });

  it('writes without conflict when baseHash matches', async () => {
    const root = await makeVault({ 'a.md': 'v1' });
    const r = await writeNoteAtomic(root, 'a.md', 'v2', hashContent('v1'));
    expect(r.conflict).toBe(false);
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('v2');
  });

  it('reports conflict with current disk content when baseHash is stale', async () => {
    const root = await makeVault({ 'a.md': 'disk-version' });
    const r = await writeNoteAtomic(root, 'a.md', 'mine', hashContent('old-version'));
    expect(r.conflict).toBe(true);
    if (r.conflict) expect(r.current.content).toBe('disk-version');
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('disk-version');
  });

  it('creates missing files and parent dirs, leaves no temp files', async () => {
    const root = await makeVault({});
    const r = await writeNoteAtomic(root, 'deep/dir/new.md', 'x');
    expect(r.conflict).toBe(false);
    expect(await readFile(path.join(root, 'deep/dir/new.md'), 'utf8')).toBe('x');
    expect((await readdir(path.join(root, 'deep/dir'))).sort()).toEqual(['new.md']);
  });

  it('finds a free -copy name', async () => {
    const root = await makeVault({ 'n.md': '', 'n-copy.md': '' });
    expect(await uniqueCopyPath(root, 'n.md')).toBe('n-copy-2.md');
  });

  it('classifies hidden names', () => {
    expect(isHiddenName('.obsidian')).toBe(true);
    expect(isHiddenName('node_modules')).toBe(true);
    expect(isHiddenName('Notes')).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run server/test/files.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`server/src/vault/files.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveVaultPath } from './paths.js';

export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface NoteFile {
  content: string;
  mtimeMs: number;
  hash: string;
}

export async function readNote(root: string, rel: string): Promise<NoteFile> {
  const abs = resolveVaultPath(root, rel);
  const [content, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
  return { content, mtimeMs: stat.mtimeMs, hash: hashContent(content) };
}

export type WriteResult =
  | { conflict: false; mtimeMs: number; hash: string }
  | { conflict: true; current: NoteFile };

export async function writeNoteAtomic(
  root: string,
  rel: string,
  content: string,
  baseHash?: string,
): Promise<WriteResult> {
  const abs = resolveVaultPath(root, rel);
  if (baseHash !== undefined) {
    let current: NoteFile | null = null;
    try {
      current = await readNote(root, rel);
    } catch {
      // file missing: treat as create
    }
    if (current && current.hash !== baseHash) return { conflict: true, current };
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.tmp-${randomBytes(6).toString('hex')}`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, abs);
  const stat = await fs.stat(abs);
  return { conflict: false, mtimeMs: stat.mtimeMs, hash: hashContent(content) };
}

export async function uniqueCopyPath(root: string, rel: string): Promise<string> {
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const base = path.posix.basename(rel, ext);
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}-copy${ext}` : `${base}-copy-${i}${ext}`;
    const candidate = dir === '.' ? name : `${dir}/${name}`;
    try {
      await fs.access(resolveVaultPath(root, candidate));
    } catch {
      return candidate;
    }
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run server/test/files.test.ts`
Expected: 6 PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/vault/files.ts server/test/files.test.ts server/test/helpers.ts
git commit -m "feat: vault file ops with atomic writes and conflict guard"
```

---

### Task 6: Tree building and trash delete

**Files:**
- Modify: `server/src/vault/files.ts` (append two functions)
- Test: `server/test/tree.test.ts`

**Interfaces:**
- Consumes: `isHiddenName`, `resolveVaultPath`, shared `TreeNode`
- Produces:
  - `buildTree(root: string): Promise<TreeNode>` — root node `{ name: '', path: '', type: 'folder', children }`; folders first then files, each alphabetical (localeCompare); `.md` files are `type: 'note'`, others `type: 'file'`; hidden entries skipped
  - `trashNote(root: string, rel: string): Promise<string>` — moves into `.trash/` (created if missing), suffixing `-2`, `-3`… on name collision; returns the new vault-relative path

- [ ] **Step 1: Write the failing tests**

`server/test/tree.test.ts`:
```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTree, trashNote } from '../src/vault/files.js';
import { makeVault } from './helpers.js';

describe('buildTree', () => {
  it('builds a sorted tree, folders first, hidden entries skipped', async () => {
    const root = await makeVault({
      'b.md': '',
      'a.md': '',
      'img.png': '',
      'sub/inner.md': '',
      '.obsidian/app.json': '{}',
      '.trash/old.md': '',
    });
    const tree = await buildTree(root);
    expect(tree.children!.map((c) => c.path)).toEqual(['sub', 'a.md', 'b.md', 'img.png']);
    expect(tree.children![0]!.children!.map((c) => c.path)).toEqual(['sub/inner.md']);
    expect(tree.children!.find((c) => c.path === 'img.png')!.type).toBe('file');
    expect(tree.children!.find((c) => c.path === 'a.md')!.type).toBe('note');
  });
});

describe('trashNote', () => {
  it('moves the note into .trash and dodges collisions', async () => {
    const root = await makeVault({ 'n.md': 'one', '.trash/n.md': 'earlier' });
    const dest = await trashNote(root, 'n.md');
    expect(dest).toBe('.trash/n-2.md');
    expect(await readFile(path.join(root, dest), 'utf8')).toBe('one');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/tree.test.ts`
Expected: FAIL — `buildTree` not exported.

- [ ] **Step 3: Implement (append to `server/src/vault/files.ts`)**

```ts
import type { TreeNode } from '@noteviewer/shared';
```
(add to the imports at the top), then append:
```ts
export async function buildTree(root: string): Promise<TreeNode> {
  const rootAbs = resolveVaultPath(root, '');
  async function walk(absDir: string, relDir: string): Promise<TreeNode[]> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (isHiddenName(e.name)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        nodes.push({
          name: e.name,
          path: rel,
          type: 'folder',
          children: await walk(path.join(absDir, e.name), rel),
        });
      } else if (e.isFile()) {
        nodes.push({
          name: e.name,
          path: rel,
          type: e.name.endsWith('.md') ? 'note' : 'file',
        });
      }
    }
    nodes.sort(
      (a, b) =>
        (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1) ||
        a.name.localeCompare(b.name),
    );
    return nodes;
  }
  return { name: '', path: '', type: 'folder', children: await walk(rootAbs, '') };
}

export async function trashNote(root: string, rel: string): Promise<string> {
  const abs = resolveVaultPath(root, rel);
  const trashDir = path.join(resolveVaultPath(root, ''), '.trash');
  await fs.mkdir(trashDir, { recursive: true });
  const ext = path.posix.extname(rel);
  const base = path.posix.basename(rel, ext);
  let target = `.trash/${base}${ext}`;
  for (let i = 2; ; i++) {
    try {
      await fs.access(path.join(resolveVaultPath(root, ''), target));
      target = `.trash/${base}-${i}${ext}`;
    } catch {
      break;
    }
  }
  await fs.rename(abs, path.join(resolveVaultPath(root, ''), target));
  return target;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/test/tree.test.ts`
Expected: 2 PASS. Also run `npx vitest run` — all previous tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/vault/files.ts server/test/tree.test.ts
git commit -m "feat: vault tree building and trash-based delete"
```

---

### Task 7: Vault index — metadata, link resolution, backlinks

**Files:**
- Create: `server/src/vault/indexer.ts`
- Test: `server/test/indexer.test.ts`

**Interfaces:**
- Consumes: `parseNote` (Task 4), `readNote`/`isHiddenName` (Task 5), shared `NoteMeta`/`SearchResult`
- Produces `class VaultIndex`:
  - `constructor(root: string)`
  - `init(): Promise<void>` — walks the vault (skipping hidden dirs), indexes every `.md`
  - `updateNote(rel: string): Promise<void>` / `removeNote(rel: string): void`
  - `getMeta(rel: string): NoteMeta | undefined`
  - `allNotes(): NoteMeta[]`
  - `resolveLink(target: string): string | undefined` — exact vault path (with or without `.md`) wins; else case-insensitive basename match, shortest path wins (Obsidian "shortest path" behavior)
  - `backlinksOf(rel: string): string[]` — sorted paths of notes whose links resolve to `rel`
  - `search(q: string): SearchResult[]` — implemented in Task 8; declare the method now returning `[]`

- [ ] **Step 1: Write the failing tests**

`server/test/indexer.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VaultIndex } from '../src/vault/indexer.js';
import { makeVault } from './helpers.js';

async function indexed(files: Record<string, string>) {
  const index = new VaultIndex(await makeVault(files));
  await index.init();
  return index;
}

describe('VaultIndex', () => {
  it('indexes all markdown, skipping hidden dirs', async () => {
    const index = await indexed({
      'a.md': '# A',
      'sub/b.md': '# B',
      '.obsidian/x.md': 'not indexed',
      '.trash/y.md': 'not indexed',
    });
    expect(index.allNotes().map((n) => n.path).sort()).toEqual(['a.md', 'sub/b.md']);
    expect(index.getMeta('a.md')!.title).toBe('A');
  });

  it('falls back to filename as title', async () => {
    const index = await indexed({ 'No Heading.md': 'just text' });
    expect(index.getMeta('No Heading.md')!.title).toBe('No Heading');
  });

  it('resolves links by exact path and by shortest basename match', async () => {
    const index = await indexed({
      'Note.md': '',
      'deep/dir/Note.md': '',
      'deep/Other.md': '',
    });
    expect(index.resolveLink('deep/Other')).toBe('deep/Other.md');
    expect(index.resolveLink('Note')).toBe('Note.md');
    expect(index.resolveLink('other')).toBe('deep/Other.md');
    expect(index.resolveLink('Missing')).toBeUndefined();
  });

  it('computes backlinks through link resolution', async () => {
    const index = await indexed({
      'a.md': 'links to [[b]] and [[sub/c]]',
      'b.md': 'links to [[sub/c|alias]]',
      'sub/c.md': 'no links',
    });
    expect(index.backlinksOf('sub/c.md')).toEqual(['a.md', 'b.md']);
    expect(index.backlinksOf('b.md')).toEqual(['a.md']);
    expect(index.backlinksOf('a.md')).toEqual([]);
  });

  it('updates and removes notes incrementally', async () => {
    const index = await indexed({ 'a.md': '# Old', 'b.md': '[[a]]' });
    const root = index.root;
    const { writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await writeFile(path.join(root, 'a.md'), '# New');
    await index.updateNote('a.md');
    expect(index.getMeta('a.md')!.title).toBe('New');
    index.removeNote('b.md');
    expect(index.backlinksOf('a.md')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/indexer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/vault/indexer.ts`:
```ts
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

  search(_q: string): SearchResult[] {
    return []; // implemented in the search task
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/test/indexer.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/vault/indexer.ts server/test/indexer.test.ts
git commit -m "feat: in-memory vault index with backlinks and link resolution"
```

---

### Task 8: Full-text search

**Files:**
- Modify: `server/src/vault/indexer.ts` (replace the stub `search`)
- Test: `server/test/search.test.ts`

**Interfaces:**
- Consumes: `VaultIndex` internals (Task 7)
- Produces: `VaultIndex.search(q: string): SearchResult[]` — MiniSearch over title+content, prefix + fuzzy 0.2, title boosted 2x, max 50 results; empty/whitespace query returns `[]`

- [ ] **Step 1: Write the failing tests**

`server/test/search.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VaultIndex } from '../src/vault/indexer.js';
import { makeVault } from './helpers.js';

describe('search', () => {
  it('finds notes by content and ranks title matches first', async () => {
    const index = new VaultIndex(
      await makeVault({
        'Kubernetes.md': '# Kubernetes\ncluster orchestration',
        'journal.md': 'Today I debugged kubernetes networking for hours.',
        'unrelated.md': 'grocery list',
      }),
    );
    await index.init();
    const results = index.search('kubernetes');
    expect(results.map((r) => r.path)).toContain('journal.md');
    expect(results[0]!.path).toBe('Kubernetes.md');
    expect(results.map((r) => r.path)).not.toContain('unrelated.md');
  });

  it('matches prefixes', async () => {
    const index = new VaultIndex(await makeVault({ 'a.md': 'esphome firmware' }));
    await index.init();
    expect(index.search('esph').map((r) => r.path)).toContain('a.md');
  });

  it('returns [] for empty queries and drops removed notes', async () => {
    const index = new VaultIndex(await makeVault({ 'a.md': 'hello world' }));
    await index.init();
    expect(index.search('  ')).toEqual([]);
    index.removeNote('a.md');
    expect(index.search('hello')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/search.test.ts`
Expected: FAIL — search returns `[]`.

- [ ] **Step 3: Implement — replace the stub in `server/src/vault/indexer.ts`**

```ts
  search(q: string): SearchResult[] {
    if (!q.trim()) return [];
    return this.mini
      .search(q)
      .slice(0, 50)
      .map((r) => ({ path: r.id as string, title: r['title'] as string, score: r.score }));
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/test/search.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/vault/indexer.ts server/test/search.test.ts
git commit -m "feat: MiniSearch full-text search"
```

---

### Task 9: Wikilink rewriting for renames

**Files:**
- Create: `server/src/vault/rename.ts`
- Test: `server/test/rename.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `rewriteLinks(content: string, oldName: string, newName: string): string` — names are basenames without `.md`; rewrites `[[Old]]`, `[[Old|alias]]`, `[[Old#heading]]`; must NOT touch `[[Older]]` or non-link text

- [ ] **Step 1: Write the failing tests**

`server/test/rename.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { rewriteLinks } from '../src/vault/rename.js';

describe('rewriteLinks', () => {
  it('rewrites plain, aliased, and heading links', () => {
    const input = 'See [[Old]], [[Old|the alias]], [[Old#Section]].';
    expect(rewriteLinks(input, 'Old', 'New')).toBe(
      'See [[New]], [[New|the alias]], [[New#Section]].',
    );
  });

  it('does not touch links that merely share a prefix, or plain text', () => {
    const input = '[[Older]] notes mention Old habits.';
    expect(rewriteLinks(input, 'Old', 'New')).toBe(input);
  });

  it('escapes regex metacharacters in names', () => {
    expect(rewriteLinks('link [[C++ (notes)]]', 'C++ (notes)', 'Cpp')).toBe('link [[Cpp]]');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/rename.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/vault/rename.ts`:
```ts
export function rewriteLinks(content: string, oldName: string, newName: string): string {
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(new RegExp(`\\[\\[${escaped}(?=[#|\\]])`, 'g'), `[[${newName}`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/test/rename.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/vault/rename.ts server/test/rename.test.ts
git commit -m "feat: wikilink rewriting for note renames"
```

---

### Task 10: Event bus and vault watcher

**Files:**
- Create: `server/src/vault/watcher.ts`
- Test: `server/test/watcher.test.ts`

**Interfaces:**
- Consumes: `VaultIndex` (Task 7), `isHiddenName` (Task 5), shared `VaultEvent`
- Produces:
  - `class VaultBus` — `emitEvent(e: VaultEvent): void`, `onEvent(fn: (e: VaultEvent) => void): () => void` (returns unsubscribe)
  - `createChangeHandler(index: VaultIndex, bus: VaultBus, root: string)` → `(kind: 'add'|'change'|'unlink'|'addDir'|'unlinkDir', absPath: string) => Promise<void>` — pure handler, unit-testable without chokidar. Hidden paths ignored. `.md` add/change → `updateNote` + `note-changed` (+ `tree-changed` on add); unlink → `removeNote` + both events; non-md and dirs → `tree-changed` only.
  - `startWatcher(root: string, handler: ...): FSWatcher` — thin chokidar wiring, `ignoreInitial`, `awaitWriteFinish { stabilityThreshold: 300, pollInterval: 100 }`, hidden dirs ignored. Not unit-tested (integration-covered later by Playwright in Plan 2); keep it under 15 lines.

- [ ] **Step 1: Write the failing tests**

`server/test/watcher.test.ts`:
```ts
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VaultEvent } from '@noteviewer/shared';
import { VaultIndex } from '../src/vault/indexer.js';
import { VaultBus, createChangeHandler } from '../src/vault/watcher.js';
import { makeVault } from './helpers.js';

async function setup(files: Record<string, string>) {
  const root = await makeVault(files);
  const index = new VaultIndex(root);
  await index.init();
  const bus = new VaultBus();
  const events: VaultEvent[] = [];
  bus.onEvent((e) => events.push(e));
  return { root, index, bus, events, handler: createChangeHandler(index, bus, root) };
}

describe('createChangeHandler', () => {
  it('indexes changed markdown and emits note-changed', async () => {
    const s = await setup({ 'a.md': '# Old' });
    await writeFile(path.join(s.root, 'a.md'), '# New');
    await s.handler('change', path.join(s.root, 'a.md'));
    expect(s.index.getMeta('a.md')!.title).toBe('New');
    expect(s.events).toEqual([{ type: 'note-changed', path: 'a.md' }]);
  });

  it('removes unlinked notes and emits both events', async () => {
    const s = await setup({ 'a.md': 'x' });
    await s.handler('unlink', path.join(s.root, 'a.md'));
    expect(s.index.getMeta('a.md')).toBeUndefined();
    expect(s.events).toEqual([
      { type: 'tree-changed' },
      { type: 'note-changed', path: 'a.md' },
    ]);
  });

  it('ignores hidden paths entirely', async () => {
    const s = await setup({});
    await s.handler('add', path.join(s.root, '.git/objects/aa'));
    await s.handler('change', path.join(s.root, '.trash/x.md'));
    expect(s.events).toEqual([]);
  });

  it('emits only tree-changed for attachments and folders', async () => {
    const s = await setup({ 'img.png': '' });
    await s.handler('add', path.join(s.root, 'img.png'));
    await s.handler('addDir', path.join(s.root, 'newdir'));
    expect(s.events).toEqual([{ type: 'tree-changed' }, { type: 'tree-changed' }]);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new VaultBus();
    const seen: VaultEvent[] = [];
    const off = bus.onEvent((e) => seen.push(e));
    bus.emitEvent({ type: 'tree-changed' });
    off();
    bus.emitEvent({ type: 'tree-changed' });
    expect(seen).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/vault/watcher.ts`:
```ts
import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { VaultEvent } from '@noteviewer/shared';
import { isHiddenName } from './files.js';
import type { VaultIndex } from './indexer.js';

export class VaultBus extends EventEmitter {
  emitEvent(e: VaultEvent): void {
    this.emit('event', e);
  }
  onEvent(fn: (e: VaultEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export type ChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export function createChangeHandler(index: VaultIndex, bus: VaultBus, root: string) {
  return async (kind: ChangeKind, absPath: string): Promise<void> => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    if (!rel || rel.split('/').some(isHiddenName)) return;
    if (kind === 'addDir' || kind === 'unlinkDir' || !rel.endsWith('.md')) {
      bus.emitEvent({ type: 'tree-changed' });
      return;
    }
    if (kind === 'unlink') index.removeNote(rel);
    else await index.updateNote(rel);
    if (kind !== 'change') bus.emitEvent({ type: 'tree-changed' });
    bus.emitEvent({ type: 'note-changed', path: rel });
  };
}

export function startWatcher(
  root: string,
  handler: ReturnType<typeof createChangeHandler>,
): FSWatcher {
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p: string) =>
      path.relative(root, p).split(path.sep).some((part) => part && isHiddenName(part)),
  });
  const kinds: ChangeKind[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'];
  for (const kind of kinds) watcher.on(kind, (p: string) => void handler(kind, p));
  return watcher;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/test/watcher.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/vault/watcher.ts server/test/watcher.test.ts
git commit -m "feat: vault event bus and chokidar change handler"
```

---

### Task 11: Fastify app — tree and note read/write routes

**Files:**
- Create: `server/src/app.ts`
- Create: `server/src/routes/vault-routes.ts`
- Test: `server/test/routes-notes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–10
- Produces:
  - `buildApp(opts: { vaultRoot: string; watch?: boolean }): Promise<FastifyInstance>` — inits index; decorates `app.vaultRoot`, `app.index` (VaultIndex), `app.bus` (VaultBus); registers routes; when `watch: true` starts the chokidar watcher and closes it in `onClose`
  - Routes (this task): `GET /api/tree` → `TreeNode`; `GET /api/note/*` → `NoteResponse` or 404; `PUT /api/note/*` body `{ content: string; baseHash?: string }` → 200 `{ mtimeMs, hash }`, or 409 `{ current: NoteFile }`; PUT re-indexes and emits `note-changed`
  - Fastify module augmentation for the three decorations lives at the top of `app.ts`

- [ ] **Step 1: Write the failing tests**

`server/test/routes-notes.test.ts`:
```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashContent } from '../src/vault/files.js';
import { makeVault } from './helpers.js';

let app: FastifyInstance;
afterEach(() => app?.close());

async function appFor(files: Record<string, string>) {
  const root = await makeVault(files);
  app = await buildApp({ vaultRoot: root });
  return { app, root };
}

describe('GET /api/tree', () => {
  it('returns the vault tree', async () => {
    const { app } = await appFor({ 'a.md': '', 'sub/b.md': '' });
    const res = await app.inject({ method: 'GET', url: '/api/tree' });
    expect(res.statusCode).toBe(200);
    expect(res.json().children.map((c: { path: string }) => c.path)).toEqual(['sub', 'a.md']);
  });
});

describe('GET /api/note/*', () => {
  it('returns content, meta, and backlinks', async () => {
    const { app } = await appFor({ 'a.md': 'links [[b]]', 'b.md': '# B' });
    const res = await app.inject({ method: 'GET', url: '/api/note/b.md' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('# B');
    expect(body.meta.title).toBe('B');
    expect(body.meta.hash).toBe(hashContent('# B'));
    expect(body.backlinks).toEqual(['a.md']);
  });

  it('404s on missing notes and path escapes', async () => {
    const { app } = await appFor({});
    expect((await app.inject({ url: '/api/note/nope.md' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/note/..%2Fescape.md' })).statusCode).toBe(404);
  });
});

describe('PUT /api/note/*', () => {
  it('saves when baseHash matches and reports the new hash', async () => {
    const { app, root } = await appFor({ 'a.md': 'v1' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/note/a.md',
      payload: { content: 'v2', baseHash: hashContent('v1') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hash).toBe(hashContent('v2'));
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('v2');
  });

  it('409s with disk content on stale baseHash', async () => {
    const { app, root } = await appFor({ 'a.md': 'disk' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/note/a.md',
      payload: { content: 'mine', baseHash: hashContent('other') },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().current.content).toBe('disk');
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('disk');
  });

  it('re-indexes after save so search/meta stay fresh', async () => {
    const { app } = await appFor({ 'a.md': '# Old' });
    await app.inject({
      method: 'PUT',
      url: '/api/note/a.md',
      payload: { content: '# Fresh', baseHash: hashContent('# Old') },
    });
    const res = await app.inject({ url: '/api/note/a.md' });
    expect(res.json().meta.title).toBe('Fresh');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/routes-notes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { VaultIndex } from './vault/indexer.js';
import { VaultBus, createChangeHandler, startWatcher } from './vault/watcher.js';
import { vaultRoutes } from './routes/vault-routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    vaultRoot: string;
    index: VaultIndex;
    bus: VaultBus;
  }
}

export interface AppOpts {
  vaultRoot: string;
  watch?: boolean;
}

export async function buildApp(opts: AppOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env['NODE_ENV'] === 'production' });
  const index = new VaultIndex(opts.vaultRoot);
  await index.init();
  const bus = new VaultBus();
  app.decorate('vaultRoot', opts.vaultRoot);
  app.decorate('index', index);
  app.decorate('bus', bus);
  await app.register(vaultRoutes);
  if (opts.watch) {
    const watcher = startWatcher(opts.vaultRoot, createChangeHandler(index, bus, opts.vaultRoot));
    app.addHook('onClose', async () => {
      await watcher.close();
    });
  }
  return app;
}
```

`server/src/routes/vault-routes.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { NoteResponse } from '@noteviewer/shared';
import { buildTree, readNote, writeNoteAtomic } from '../vault/files.js';
import { PathError } from '../vault/paths.js';

function relParam(params: unknown): string {
  return decodeURIComponent((params as Record<string, string>)['*'] ?? '');
}

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tree', async () => buildTree(app.vaultRoot));

  app.get('/api/note/*', async (req, reply) => {
    const rel = relParam(req.params);
    try {
      const file = await readNote(app.vaultRoot, rel);
      await app.index.updateNote(rel);
      const meta = app.index.getMeta(rel)!;
      const body: NoteResponse = {
        meta,
        backlinks: app.index.backlinksOf(rel),
        content: file.content,
      };
      return body;
    } catch (err) {
      if (err instanceof PathError || (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: 'note not found' });
      }
      throw err;
    }
  });

  app.put<{ Body: { content: string; baseHash?: string } }>(
    '/api/note/*',
    {
      schema: {
        body: {
          type: 'object',
          required: ['content'],
          properties: { content: { type: 'string' }, baseHash: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const rel = relParam(req.params);
      try {
        const result = await writeNoteAtomic(
          app.vaultRoot,
          rel,
          req.body.content,
          req.body.baseHash,
        );
        if (result.conflict) return reply.code(409).send({ current: result.current });
        await app.index.updateNote(rel);
        app.bus.emitEvent({ type: 'note-changed', path: rel });
        return { mtimeMs: result.mtimeMs, hash: result.hash };
      } catch (err) {
        if (err instanceof PathError) return reply.code(404).send({ error: 'bad path' });
        throw err;
      }
    },
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/test/routes-notes.test.ts`
Expected: 6 PASS. Then `npx vitest run` — everything PASS. Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/routes/vault-routes.ts server/test/routes-notes.test.ts
git commit -m "feat: fastify app with tree and note read/write routes"
```

---

### Task 12: Create, delete, rename, search, file, and SSE routes

**Files:**
- Modify: `server/src/routes/vault-routes.ts`
- Test: `server/test/routes-mutations.test.ts`

**Interfaces:**
- Consumes: `trashNote`, `uniqueCopyPath`, `writeNoteAtomic`, `rewriteLinks`, `resolveVaultPath`, `isHiddenName`, index, bus
- Produces routes:
  - `POST /api/note` body `{ path: string; content?: string; unique?: boolean }` → 201 `{ path, mtimeMs, hash }`; existing path → 409 unless `unique: true`, which writes to `uniqueCopyPath` and returns the actual path (this is the "save as copy" backend)
  - `DELETE /api/note/*` → 200 `{ trashedTo: string }`; moves to `.trash/`, de-indexes, emits `tree-changed`
  - `POST /api/rename` body `{ from: string; to: string }` → 200 `{ rewritten: string[] }`; 409 if `to` exists; moves the file, rewrites wikilinks in referrer notes (basenames), updates index, emits `tree-changed` + `note-changed` per rewritten note
  - `GET /api/search?q=` → `SearchResult[]`
  - `GET /api/file/*` → streams attachment via `@fastify/static` `sendFile`; 404 for hidden paths
  - `GET /api/events` → SSE (`text/event-stream`), one `data: <json VaultEvent>` per bus event, `: ping` comment every 25 s, unsubscribes on close. Note for Plan 2: clients ignore `note-changed` whose refetched hash equals their last save (echo suppression).

- [ ] **Step 1: Write the failing tests**

`server/test/routes-mutations.test.ts`:
```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { makeVault } from './helpers.js';

let app: FastifyInstance;
afterEach(() => app?.close());

async function appFor(files: Record<string, string>) {
  const root = await makeVault(files);
  app = await buildApp({ vaultRoot: root });
  return { app, root };
}

describe('POST /api/note', () => {
  it('creates a note', async () => {
    const { app, root } = await appFor({});
    const res = await app.inject({
      method: 'POST',
      url: '/api/note',
      payload: { path: 'new.md', content: '# New' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe('new.md');
    expect(await readFile(path.join(root, 'new.md'), 'utf8')).toBe('# New');
  });

  it('409s on existing path, saves-as-copy with unique flag', async () => {
    const { app, root } = await appFor({ 'n.md': 'original' });
    const clash = await app.inject({
      method: 'POST',
      url: '/api/note',
      payload: { path: 'n.md', content: 'mine' },
    });
    expect(clash.statusCode).toBe(409);
    const copy = await app.inject({
      method: 'POST',
      url: '/api/note',
      payload: { path: 'n.md', content: 'mine', unique: true },
    });
    expect(copy.statusCode).toBe(201);
    expect(copy.json().path).toBe('n-copy.md');
    expect(await readFile(path.join(root, 'n-copy.md'), 'utf8')).toBe('mine');
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('original');
  });
});

describe('DELETE /api/note/*', () => {
  it('moves to .trash and de-indexes', async () => {
    const { app, root } = await appFor({ 'a.md': 'bye' });
    const res = await app.inject({ method: 'DELETE', url: '/api/note/a.md' });
    expect(res.statusCode).toBe(200);
    expect(res.json().trashedTo).toBe('.trash/a.md');
    expect(await readFile(path.join(root, '.trash/a.md'), 'utf8')).toBe('bye');
    expect((await app.inject({ url: '/api/note/a.md' })).statusCode).toBe(404);
  });
});

describe('POST /api/rename', () => {
  it('moves the note and rewrites referring wikilinks', async () => {
    const { app, root } = await appFor({
      'Old.md': '# Old',
      'ref.md': 'see [[Old]] and [[Old|alias]]',
      'unrelated.md': '[[Older]] stays',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rename',
      payload: { from: 'Old.md', to: 'sub/New.md' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rewritten).toEqual(['ref.md']);
    expect(await readFile(path.join(root, 'sub/New.md'), 'utf8')).toBe('# Old');
    expect(await readFile(path.join(root, 'ref.md'), 'utf8')).toBe(
      'see [[New]] and [[New|alias]]',
    );
    expect(await readFile(path.join(root, 'unrelated.md'), 'utf8')).toBe('[[Older]] stays');
  });

  it('409s when the target exists', async () => {
    const { app } = await appFor({ 'a.md': '', 'b.md': '' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rename',
      payload: { from: 'a.md', to: 'b.md' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /api/search', () => {
  it('searches indexed notes', async () => {
    const { app } = await appFor({ 'a.md': 'quantum flux capacitor' });
    const res = await app.inject({ url: '/api/search?q=quantum' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: { path: string }) => r.path)).toEqual(['a.md']);
  });
});

describe('GET /api/file/*', () => {
  it('serves attachments and hides dotpaths', async () => {
    const { app } = await appFor({ 'img.svg': '<svg/>', '.obsidian/app.json': '{}' });
    const ok = await app.inject({ url: '/api/file/img.svg' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('<svg/>');
    expect((await app.inject({ url: '/api/file/.obsidian/app.json' })).statusCode).toBe(404);
  });
});

describe('GET /api/events', () => {
  it('streams bus events as SSE', async () => {
    const { app } = await appFor({});
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    app.bus.emitEvent({ type: 'note-changed', path: 'x.md' });
    // accumulate chunks: the first read may only contain the `retry:` preamble
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('"note-changed"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('"note-changed"');
    expect(text).toContain('x.md');
    await reader.cancel();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/test/routes-mutations.test.ts`
Expected: FAIL — 404s on the new routes.

- [ ] **Step 3: Implement — extend `server/src/routes/vault-routes.ts`**

Add imports at the top:
```ts
import fs from 'node:fs/promises';
import fastifyStatic from '@fastify/static';
import {
  buildTree,
  isHiddenName,
  readNote,
  trashNote,
  uniqueCopyPath,
  writeNoteAtomic,
} from '../vault/files.js';
import { resolveVaultPath, PathError } from '../vault/paths.js';
import { rewriteLinks } from '../vault/rename.js';
import path from 'node:path';
```
(merge with the existing import of `buildTree`/`readNote`/`writeNoteAtomic`/`PathError`), register static serving at the top of `vaultRoutes` (before the routes):
```ts
  await app.register(fastifyStatic, { root: app.vaultRoot, serve: false });
```
then append inside `vaultRoutes`:
```ts
  app.post<{ Body: { path: string; content?: string; unique?: boolean } }>(
    '/api/note',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            unique: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      let rel = req.body.path;
      try {
        let exists = true;
        try {
          await fs.access(resolveVaultPath(app.vaultRoot, rel));
        } catch {
          exists = false;
        }
        if (exists) {
          if (!req.body.unique) return reply.code(409).send({ error: 'already exists' });
          rel = await uniqueCopyPath(app.vaultRoot, rel);
        }
        const result = await writeNoteAtomic(app.vaultRoot, rel, req.body.content ?? '');
        if (result.conflict) return reply.code(409).send({ error: 'already exists' });
        await app.index.updateNote(rel);
        app.bus.emitEvent({ type: 'tree-changed' });
        app.bus.emitEvent({ type: 'note-changed', path: rel });
        return reply.code(201).send({ path: rel, mtimeMs: result.mtimeMs, hash: result.hash });
      } catch (err) {
        if (err instanceof PathError) return reply.code(400).send({ error: 'bad path' });
        throw err;
      }
    },
  );

  app.delete('/api/note/*', async (req, reply) => {
    const rel = relParam(req.params);
    try {
      const trashedTo = await trashNote(app.vaultRoot, rel);
      app.index.removeNote(rel);
      app.bus.emitEvent({ type: 'tree-changed' });
      return { trashedTo };
    } catch (err) {
      if (err instanceof PathError || (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: 'note not found' });
      }
      throw err;
    }
  });

  app.post<{ Body: { from: string; to: string } }>(
    '/api/rename',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'to'],
          properties: { from: { type: 'string' }, to: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const { from, to } = req.body;
      try {
        const fromAbs = resolveVaultPath(app.vaultRoot, from);
        const toAbs = resolveVaultPath(app.vaultRoot, to);
        try {
          await fs.access(toAbs);
          return reply.code(409).send({ error: 'target exists' });
        } catch {
          // target free
        }
        const referrers = app.index.backlinksOf(from);
        await fs.mkdir(path.dirname(toAbs), { recursive: true });
        await fs.rename(fromAbs, toAbs);
        const oldName = path.posix.basename(from, '.md');
        const newName = path.posix.basename(to, '.md');
        const rewritten: string[] = [];
        for (const ref of referrers) {
          const file = await readNote(app.vaultRoot, ref);
          const updated = rewriteLinks(file.content, oldName, newName);
          if (updated !== file.content) {
            await writeNoteAtomic(app.vaultRoot, ref, updated, file.hash);
            await app.index.updateNote(ref);
            rewritten.push(ref);
          }
        }
        app.index.removeNote(from);
        await app.index.updateNote(to);
        app.bus.emitEvent({ type: 'tree-changed' });
        for (const ref of rewritten) app.bus.emitEvent({ type: 'note-changed', path: ref });
        return { rewritten };
      } catch (err) {
        if (err instanceof PathError || (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.code(404).send({ error: 'source not found' });
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) =>
    app.index.search(req.query.q ?? ''),
  );

  app.get('/api/file/*', async (req, reply) => {
    const rel = relParam(req.params);
    if (rel.split('/').some(isHiddenName)) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile(rel);
  });

  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write('retry: 3000\n\n');
    const off = app.bus.onEvent((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/test/routes-mutations.test.ts`
Expected: 9 PASS. Then `npx vitest run` and `npm run typecheck` — all clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/vault-routes.ts server/test/routes-mutations.test.ts
git commit -m "feat: mutation, search, file, and SSE routes"
```

---

### Task 13: Entrypoint, Dockerfile, compose, and GHCR workflow

**Files:**
- Create: `server/src/main.ts`
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`
- Create: `.github/workflows/docker.yml`
- Modify: `server/src/app.ts` (serve web build + SPA fallback when `serveWeb` is set)

**Interfaces:**
- Consumes: `buildApp` (Task 11)
- Produces: `node server via tsx` listening on `PORT` against `VAULT_PATH`; image `ghcr.io/glitchtit/noteviewer:latest` built and pushed by CI on every push to `main` after tests pass

- [ ] **Step 1: Extend `buildApp` for static web serving**

In `server/src/app.ts`, add to `AppOpts`:
```ts
export interface AppOpts {
  vaultRoot: string;
  watch?: boolean;
  /** absolute path to web/dist; when set, serves the SPA with index.html fallback */
  serveWeb?: string;
}
```
and after `await app.register(vaultRoutes);` add:
```ts
  if (opts.serveWeb) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, {
      root: opts.serveWeb,
      prefix: '/',
      decorateReply: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').send(
          // SPA fallback: any non-API route serves the app shell
          createReadStream(path.join(opts.serveWeb!, 'index.html')),
        );
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }
```
with `import { createReadStream } from 'node:fs';` and `import path from 'node:path';` added to the imports.

- [ ] **Step 2: Write the entrypoint**

`server/src/main.ts`:
```ts
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const vaultRoot = process.env['VAULT_PATH'] ?? '/vault';
const port = Number(process.env['PORT'] ?? 8080);
const webDist = path.resolve(fileURLToPath(import.meta.url), '../../../web/dist');

if (!existsSync(vaultRoot)) {
  console.error(`VAULT_PATH does not exist: ${vaultRoot}`);
  process.exit(1);
}

const app = await buildApp({
  vaultRoot,
  watch: true,
  serveWeb: existsSync(webDist) ? webDist : undefined,
});

await app.listen({ port, host: '0.0.0.0' });
console.log(`noteviewer listening on :${port}, vault: ${vaultRoot}`);
```

- [ ] **Step 3: Verify locally against a scratch vault**

```bash
TESTVAULT="$(mktemp -d)"
printf '# Hello\nlinks [[World]]' > "$TESTVAULT/Hello.md"
VAULT_PATH="$TESTVAULT" PORT=8123 npx tsx server/src/main.ts &
sleep 2
curl -s http://127.0.0.1:8123/api/tree
curl -s http://127.0.0.1:8123/api/note/Hello.md
kill %1
```
(reuse `$TESTVAULT` in Step 5's docker run)
Expected: tree JSON listing `Hello.md`; note JSON with `"title":"Hello"`.

- [ ] **Step 4: Write Docker and CI files**

`.dockerignore`:
```
node_modules
**/node_modules
**/dist
.git
docs
```

`Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build -w web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production VAULT_PATH=/vault PORT=8080
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev
COPY shared shared
COPY server server
COPY --from=build /app/web/dist web/dist
EXPOSE 8080
CMD ["npx", "tsx", "server/src/main.ts"]
```

`docker-compose.yml` (local dev convenience only):
```yaml
services:
  noteviewer:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - "${VAULT_PATH:?set VAULT_PATH to your vault folder}:/vault"
```

`.github/workflows/docker.yml`:
```yaml
name: CI & Publish

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run typecheck

  publish:
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/glitchtit/noteviewer:latest
            ghcr.io/glitchtit/noteviewer:${{ github.sha }}
```

- [ ] **Step 5: Verify the Docker build**

Run: `docker build -t noteviewer-test .`
Expected: builds successfully. Then:
```bash
docker run --rm -d --name nv-test -p 8124:8080 -v "$TESTVAULT:/vault" noteviewer-test
sleep 3
curl -s http://127.0.0.1:8124/api/tree
docker rm -f nv-test
```
Expected: tree JSON with `Hello.md`.

- [ ] **Step 6: Run the full suite one last time**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/main.ts server/src/app.ts Dockerfile .dockerignore docker-compose.yml .github/workflows/docker.yml
git commit -m "feat: entrypoint, Docker image, and GHCR publish workflow"
```

---

## After this plan

- Create the GitHub repo (`gh repo create Glitchtit/noteviewer --public`), push, confirm the Actions run goes green and the package appears at `ghcr.io/glitchtit/noteviewer`; set the package visibility to public so Unraid can pull anonymously.
- On Unraid: add a container with image `ghcr.io/glitchtit/noteviewer:latest`, path mapping `/mnt/user/appdata/obsidian/Obsidian Vault` → `/vault` (read-write), port 8080, then put Cloudflare Zero Trust in front.
- Plan 2 (web app core: shell, tree, CodeMirror editor, autosave, conflict bar, SSE client) is written once this plan is executed and reviewed.
