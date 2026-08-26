# Noteviewer Rich Rendering Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the working editor into the "fully functional Obsidian clone": live-preview decorations (syntax hiding, wikilinks + autocomplete, checkboxes, images, KaTeX, Mermaid, callouts), a rendered reading mode (Ctrl+E), kanban board view, search overlay + quick switcher, backlinks/outline panel — plus the accumulated server and web hardening backlogs and expanded e2e coverage.

**Architecture:** All rendering is client-side. Reading mode uses a unified/remark→rehype pipeline in `web/src/md/render.ts`. Live preview is a set of CodeMirror 6 extensions in `web/src/cm/` (a ViewPlugin per concern) composed into `EditorPane`. Wikilink resolution is a pure client util mirroring the server's shortest-basename rule, fed from the already-loaded tree. Kanban serializes back through the existing `useNoteEditor` save path, so the conflict guard covers boards for free.

**Tech Stack additions:** unified/remark/rehype (+ remark-gfm, remark-math, rehype-raw, rehype-katex), katex, mermaid (lazy-loaded), @codemirror/autocomplete, @codemirror/language-data.

**Spec:** `docs/superpowers/specs/2026-08-26-noteviewer-design.md`

## Global Constraints

- Dark mode only. New CSS goes into `web/src/theme.css` as clearly-commented per-task blocks (Plan 2's "no new CSS" rule is lifted for THIS plan's tasks — each task appends only the block its step specifies).
- TypeScript strict; `import type` for shared types; run unit tests `npx vitest run`, e2e `npm run test:e2e`; typecheck `npm run typecheck`. No AI co-author trailers.
- **Behavior-contract latitude:** the reference implementations in this plan are complete and expected to work, but CodeMirror decoration internals are intricate — an implementer MAY adjust internal implementation details when a reference snippet fights reality, PROVIDED every specified test still passes, the task's stated behavior contract is met verbatim, and the deviation + reason is documented in the report. Public interfaces (exports, props, facets, CSS class names, keybindings) are NOT adjustable.
- Reading mode renders the user's own vault (single authed user behind Cloudflare Access); `rehype-raw` passes inline HTML through unsanitized by design — documented, accepted.
- No blocking browser dialogs anywhere (`prompt`/`confirm`/`alert` remain banned; the Task-11 `beforeunload` handler uses the standard event-preventDefault mechanism, which is exempt).
- Server code changes are confined to Task 10.

---

### Task 1: Markdown pipeline dependencies and reading-mode renderer

**Files:**
- Modify: `web/package.json` (deps), `web/src/main.tsx` (katex css import)
- Create: `web/src/md/render.ts`, `web/src/md/wikilinks.ts`, `web/src/md/callouts.ts`
- Test: `web/test/render.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `renderMarkdown(md: string): Promise<string>` — HTML string; supports GFM (tables, strikethrough, task lists), `$inline$`/`$$block$$` KaTeX, raw inline HTML, wikilinks → `<a class="internal-link" data-target="Raw Target">label</a>` (alias respected, `#heading` stripped from label handling per code), embeds `![[file]]` → `<img class="internal-embed" data-target="file">`, callouts `> [!type] Title` → `<div class="callout callout-<type>">…`, fenced ```mermaid blocks LEFT AS `<pre><code class="language-mermaid">` (Task 2 renders them)
  - remark plugins `remarkWikilinks` and `remarkCallouts` (exported for reuse)

- [ ] **Step 1: Add dependencies**

In `web/package.json` dependencies add (then `npm install`):
```json
    "@codemirror/autocomplete": "^6.18.0",
    "@codemirror/language-data": "^6.5.0",
    "katex": "^0.16.11",
    "mermaid": "^11.4.0",
    "rehype-katex": "^7.0.0",
    "rehype-raw": "^7.0.0",
    "rehype-stringify": "^10.0.0",
    "remark-gfm": "^4.0.0",
    "remark-math": "^6.0.0",
    "remark-parse": "^11.0.0",
    "remark-rehype": "^11.0.0",
    "unified": "^11.0.0",
    "unist-util-visit": "^5.0.0",
```
and devDependencies: `"@types/katex": "^0.16.7"`.
In `web/src/main.tsx` add `import 'katex/dist/katex.min.css';` above the theme import.

- [ ] **Step 2: Write the failing tests**

`web/test/render.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/md/render';

describe('renderMarkdown', () => {
  it('renders basic markdown with GFM', async () => {
    const html = await renderMarkdown('# Title\n\nSome **bold** and ~~gone~~.\n\n- [x] done');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('checked');
  });

  it('renders wikilinks with alias and strips heading refs from targets', async () => {
    const html = await renderMarkdown('See [[Other Note]] and [[X|the alias]] and [[Y#sec]].');
    expect(html).toContain('data-target="Other Note"');
    expect(html).toContain('>Other Note</a>');
    expect(html).toContain('data-target="X"');
    expect(html).toContain('>the alias</a>');
    expect(html).toContain('data-target="Y"');
  });

  it('renders embeds as internal-embed imgs', async () => {
    const html = await renderMarkdown('![[pic.png]]');
    expect(html).toContain('class="internal-embed"');
    expect(html).toContain('data-target="pic.png"');
  });

  it('renders KaTeX math', async () => {
    const html = await renderMarkdown('Inline $x^2$ and\n\n$$\\sum_{i=0}^n i$$');
    expect(html).toContain('katex');
  });

  it('renders callouts as typed divs with title', async () => {
    const html = await renderMarkdown('> [!warning] Careful\n> body line');
    expect(html).toContain('callout callout-warning');
    expect(html).toContain('Careful');
    expect(html).toContain('body line');
  });

  it('leaves mermaid fences as language-mermaid code', async () => {
    const html = await renderMarkdown('```mermaid\ngraph TD; A-->B;\n```');
    expect(html).toContain('language-mermaid');
    expect(html).toContain('A--&#x3E;B;');
  });

  it('passes raw inline HTML through', async () => {
    const html = await renderMarkdown('a <kbd>Ctrl</kbd> key');
    expect(html).toContain('<kbd>Ctrl</kbd>');
  });
});
```
(If an entity-encoding assertion like the mermaid arrow proves encoder-dependent, assert on a stable substring of the same content instead — behavior contract: the mermaid source must survive into the code element.)

- [ ] **Step 3: Run to verify failure** — `npx vitest run --project web` → module not found.

- [ ] **Step 4: Implement**

`web/src/md/wikilinks.ts` — a remark plugin that scans text nodes for `[[target|alias]]` / `![[embed]]` and splits them into HTML nodes:
```ts
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

const WIKI = /(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

export function remarkWikilinks() {
  return (tree: Root) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return;
      const value = node.value as string;
      WIKI.lastIndex = 0;
      if (!WIKI.test(value)) return;
      WIKI.lastIndex = 0;
      const parts: unknown[] = [];
      let last = 0;
      for (const m of value.matchAll(WIKI)) {
        const [full, bang, target, , alias] = m;
        const start = m.index!;
        if (start > last) parts.push({ type: 'text', value: value.slice(last, start) });
        const cleanTarget = target!.trim();
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        if (bang === '!') {
          parts.push({ type: 'html', value: `<img class="internal-embed" data-target="${esc(cleanTarget)}" alt="${esc(cleanTarget)}">` });
        } else {
          const label = (alias ?? cleanTarget).trim();
          parts.push({ type: 'html', value: `<a class="internal-link" data-target="${esc(cleanTarget)}">${esc(label)}</a>` });
        }
        last = start + full.length;
      }
      if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
      parent.children.splice(index, 1, ...(parts as never[]));
      return index + parts.length;
    });
  };
}
```

`web/src/md/callouts.ts` — transforms blockquotes whose first line is `[!type] Title`:
```ts
import type { Blockquote, Paragraph, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

const CALLOUT = /^\[!(\w+)\][ \t]*(.*)$/;

export function remarkCallouts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const first = node.children[0];
      if (!first || first.type !== 'paragraph') return;
      const para = first as Paragraph;
      const t = para.children[0];
      if (!t || t.type !== 'text') return;
      const text = t as Text;
      const m = CALLOUT.exec(text.value.split('\n')[0]!);
      if (!m) return;
      const [, type, title] = m;
      const rest = text.value.slice(text.value.indexOf('\n') + 1);
      if (text.value.includes('\n')) text.value = rest;
      else para.children.shift();
      const data = (node.data ??= {});
      (data as { hName?: string }).hName = 'div';
      (data as { hProperties?: object }).hProperties = { className: ['callout', `callout-${type!.toLowerCase()}`] };
      node.children.unshift({
        type: 'paragraph',
        data: { hName: 'div', hProperties: { className: ['callout-title'] } },
        children: [{ type: 'text', value: title || type! }],
      } as Paragraph);
    });
  };
}
```

`web/src/md/render.ts`:
```ts
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { remarkCallouts } from './callouts';
import { remarkWikilinks } from './wikilinks';

const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkWikilinks)
  .use(remarkCallouts)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeKatex)
  .use(rehypeStringify);

export async function renderMarkdown(md: string): Promise<string> {
  // strip frontmatter; it is metadata, not content
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const file = await pipeline.process(body);
  return String(file);
}
```

- [ ] **Step 5: Run to verify pass** — all render tests PASS; full `npx vitest run` + `npm run typecheck` clean.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(web): unified markdown pipeline with wikilinks, callouts, katex"`

---

### Task 2: Reading mode (Ctrl+E) with mermaid and wikilink navigation

**Files:**
- Create: `web/src/components/ReadingView.tsx`, `web/src/resolveLink.ts`
- Modify: `web/src/App.tsx` (mode state + toggle + Ctrl+E), `web/src/theme.css` (reading-view + callout block)
- Test: `web/test/readingview.test.tsx`, `web/test/resolveLink.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown` (T1), `TreeNode`
- Produces:
  - `resolveLink(root: TreeNode, target: string): string | undefined` — exact vault path (± `.md`) wins; else case-insensitive basename match, shortest path wins; searches notes for md targets and ALL files for targets with an extension (embeds)
  - `ReadingView({ content, tree, onOpenNote }: { content: string; tree: TreeNode | null; onOpenNote(path: string): void })` — renders `renderMarkdown` output into `<div className="reading-view">`; click on `.internal-link` resolves `data-target` and calls `onOpenNote`; `.internal-embed` imgs get `src=/api/file/<encoded resolved path>` after render; `language-mermaid` code blocks are replaced by lazily-imported mermaid SVGs (dark theme, `startOnLoad: false`), falling back to the raw code block on render error
  - App: `viewMode: 'edit' | 'read'` state; Ctrl/Cmd+E toggles (global keydown, preventDefault); a topbar button (`aria-label="Toggle reading mode"`) does the same; reading mode replaces EditorPane; switching to read flushes a dirty save first (`void editor.saveNow()`)

- [ ] **Step 1: Write the failing tests**

`web/test/resolveLink.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@noteviewer/shared';
import { resolveLink } from '../src/resolveLink';

const tree: TreeNode = {
  name: '', path: '', type: 'folder',
  children: [
    { name: 'Note.md', path: 'Note.md', type: 'note' },
    {
      name: 'deep', path: 'deep', type: 'folder',
      children: [
        { name: 'Note.md', path: 'deep/Note.md', type: 'note' },
        { name: 'Other.md', path: 'deep/Other.md', type: 'note' },
        { name: 'pic.png', path: 'deep/pic.png', type: 'file' },
      ],
    },
  ],
};

describe('resolveLink', () => {
  it('prefers exact path, then shortest basename match, case-insensitive', () => {
    expect(resolveLink(tree, 'deep/Other')).toBe('deep/Other.md');
    expect(resolveLink(tree, 'Note')).toBe('Note.md');
    expect(resolveLink(tree, 'other')).toBe('deep/Other.md');
    expect(resolveLink(tree, 'Missing')).toBeUndefined();
  });

  it('resolves file embeds by basename', () => {
    expect(resolveLink(tree, 'pic.png')).toBe('deep/pic.png');
  });
});
```

`web/test/readingview.test.tsx` (mermaid is lazy-imported; mock it):
```tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '@noteviewer/shared';
import { ReadingView } from '../src/components/ReadingView';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"></svg>' }),
  },
}));

const tree: TreeNode = {
  name: '', path: '', type: 'folder',
  children: [{ name: 'Other.md', path: 'Other.md', type: 'note' }],
};

describe('ReadingView', () => {
  it('renders markdown and navigates wikilinks', async () => {
    const onOpen = vi.fn();
    render(<ReadingView content="# Hi\n\nGo to [[Other]]." tree={tree} onOpenNote={onOpen} />);
    await waitFor(() => expect(screen.getByText('Other')).toBeTruthy());
    fireEvent.click(screen.getByText('Other'));
    expect(onOpen).toHaveBeenCalledWith('Other.md');
  });

  it('renders mermaid blocks to SVG', async () => {
    render(
      <ReadingView content={'```mermaid\ngraph TD; A-->B;\n```'} tree={tree} onOpenNote={() => {}} />,
    );
    await waitFor(() => expect(document.querySelector('svg')).toBeTruthy());
  });
});
```
Note: the content strings above contain literal `\n` — write them as template literals with real newlines in the actual test file.

- [ ] **Step 2: Run to verify failure** — modules not found.

- [ ] **Step 3: Implement**

`web/src/resolveLink.ts`:
```ts
import type { TreeNode } from '@noteviewer/shared';

function collect(node: TreeNode, out: string[]): void {
  if (node.type !== 'folder') out.push(node.path);
  for (const c of node.children ?? []) collect(c, out);
}

export function resolveLink(root: TreeNode, target: string): string | undefined {
  const clean = target.split('#')[0]!.split('|')[0]!.trim();
  if (!clean) return undefined;
  const paths: string[] = [];
  collect(root, paths);
  const hasExt = /\.[A-Za-z0-9]+$/.test(clean);
  const wanted = hasExt ? clean : `${clean}.md`;
  const lower = wanted.toLowerCase();
  if (paths.some((p) => p === wanted)) return wanted;
  const matches = paths.filter((p) => p.toLowerCase() === lower || p.toLowerCase().endsWith(`/${lower}`));
  matches.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return matches[0];
}
```

`web/src/components/ReadingView.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import type { TreeNode } from '@noteviewer/shared';
import { encodePath } from '../api';
import { renderMarkdown } from '../md/render';
import { resolveLink } from '../resolveLink';

export interface ReadingViewProps {
  content: string;
  tree: TreeNode | null;
  onOpenNote(path: string): void;
}

let mermaidSeq = 0;

export function ReadingView({ content, tree, onOpenNote }: ReadingViewProps) {
  const [html, setHtml] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const openRef = useRef(onOpenNote);
  openRef.current = onOpenNote;

  useEffect(() => {
    let cancelled = false;
    void renderMarkdown(content).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [content]);

  // post-render enhancement: embeds and mermaid
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !html) return;
    for (const img of el.querySelectorAll<HTMLImageElement>('img.internal-embed')) {
      const target = img.dataset['target'];
      const resolved = target && treeRef.current ? resolveLink(treeRef.current, target) : undefined;
      if (resolved) img.src = `/api/file/${encodePath(resolved)}`;
    }
    const fences = el.querySelectorAll<HTMLElement>('code.language-mermaid');
    if (fences.length) {
      void import('mermaid').then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, theme: 'dark' });
        for (const code of fences) {
          const src = code.textContent ?? '';
          const host = code.closest('pre') ?? code;
          try {
            const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, src);
            const wrap = document.createElement('div');
            wrap.className = 'mermaid-diagram';
            wrap.innerHTML = svg;
            host.replaceWith(wrap);
          } catch {
            // leave the raw code block visible on render failure
          }
        }
      });
    }
  }, [html]);

  function onClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest('a.internal-link');
    if (!a) return;
    e.preventDefault();
    const target = (a as HTMLElement).dataset['target'];
    const resolved = target && treeRef.current ? resolveLink(treeRef.current, target) : undefined;
    if (resolved) openRef.current(resolved);
  }

  return (
    <div
      ref={containerRef}
      className="reading-view"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
```

App edits: add state `const [viewMode, setViewMode] = useState<'edit' | 'read'>('edit');`; reset to `'edit'` on `path` change is NOT wanted (Obsidian remembers per-pane; keep global mode). Add a global keydown effect:
```tsx
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void editor.saveNow();
        setViewMode((m) => (m === 'edit' ? 'read' : 'edit'));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```
Topbar button before Rename: `<button aria-label="Toggle reading mode" onClick={() => { void editor.saveNow(); setViewMode((m) => (m === 'edit' ? 'read' : 'edit')); }}>{viewMode === 'edit' ? 'Read' : 'Edit'}</button>`.
Editor block becomes:
```tsx
        {path ? (
          viewMode === 'read' ? (
            <ReadingView content={editor.state.content} tree={tree} onOpenNote={(p) => void editor.open(p)} />
          ) : (
            <EditorPane ... unchanged ... />
          )
        ) : (
          <div className="empty">Select a note</div>
        )}
```
Caveat to preserve: `editor.state.content` is the last-applied content, not unsaved keystrokes — the saveNow() before toggling closes that gap; note it in a comment.

`web/src/theme.css` — append block:
```css
/* Task 3-2: reading view & callouts */
.reading-view { flex: 1; overflow-y: auto; padding: 16px 24px; max-width: 760px; margin: 0 auto; width: 100%; line-height: 1.6; }
.reading-view h1, .reading-view h2, .reading-view h3 { line-height: 1.3; }
.reading-view a, .reading-view a.internal-link { color: var(--accent); cursor: pointer; text-decoration: none; }
.reading-view a:hover { text-decoration: underline; }
.reading-view pre { background: var(--bg-deep); padding: 12px; border-radius: 6px; overflow-x: auto; }
.reading-view code { font-family: monospace; color: var(--code); }
.reading-view blockquote { border-left: 3px solid var(--border); margin-left: 0; padding-left: 12px; color: var(--text-muted); }
.reading-view img { max-width: 100%; }
.reading-view table { border-collapse: collapse; }
.reading-view th, .reading-view td { border: 1px solid var(--border); padding: 4px 10px; }
.callout { border-left: 3px solid var(--accent); background: var(--bg-hover); border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
.callout-title { font-weight: 700; margin-bottom: 4px; }
.callout-warning, .callout-caution { border-left-color: var(--warn); }
.callout-danger, .callout-error, .callout-bug { border-left-color: var(--danger); }
.mermaid-diagram { display: flex; justify-content: center; padding: 8px 0; }
.mermaid-diagram svg { max-width: 100%; }
```

- [ ] **Step 4: Run to verify pass** — new tests + full suite + typecheck green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): reading mode with mermaid, callouts, and wikilink navigation"`

---

### Task 3: Live preview foundation — syntax-mark hiding and code-block languages

**Files:**
- Create: `web/src/cm/livePreview.ts`
- Modify: `web/src/components/EditorPane.tsx` (add extension + codeLanguages)
- Test: `web/test/livePreview.test.ts`

**Interfaces:**
- Consumes: EditorPane internals (T4 of Plan 2)
- Produces:
  - `livePreview: Extension` — ViewPlugin that hides markdown formatting marks (`HeaderMark` + its following space, `EmphasisMark`, `StrongMark` (covered by EmphasisMark nodes in lezer), `StrikethroughMark`, `CodeMark`, `QuoteMark`) via `Decoration.replace` whenever no selection range touches the LINE(S) containing the mark; recomputes on doc/selection/viewport change
  - `buildHideDecorations(view: EditorView): DecorationSet` exported for tests
  - EditorPane gains `markdown({ base: markdownLanguage, codeLanguages: languages })` (`import { languages } from '@codemirror/language-data'`) and appends `livePreview` to its extensions
- Behavior contract: with the cursor on another line, `# Title` renders without visible `# `; moving the cursor onto that line reveals the marks; fenced code blocks get language highlighting.

- [ ] **Step 1: Write the failing tests**

`web/test/livePreview.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { buildHideDecorations, livePreview } from '../src/cm/livePreview';

function viewWith(doc: string, cursor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), livePreview],
  });
  const view = new EditorView({ state, parent: document.body });
  ensureSyntaxTree(view.state, doc.length, 5000);
  return view;
}

function hiddenCount(view: EditorView): number {
  let n = 0;
  buildHideDecorations(view).between(0, view.state.doc.length, () => {
    n++;
  });
  return n;
}

describe('livePreview mark hiding', () => {
  it('hides heading and emphasis marks when the cursor is elsewhere', () => {
    const view = viewWith('# Title\n\nsome **bold** text\n\nplain', 34);
    expect(hiddenCount(view)).toBeGreaterThanOrEqual(3); // header mark + two strong marks
    view.destroy();
  });

  it('reveals marks on the active line', () => {
    const doc = '# Title\n\nsome **bold** text';
    const away = viewWith(doc, doc.length);
    const onHeading = viewWith(doc, 2);
    expect(hiddenCount(onHeading)).toBeLessThan(hiddenCount(away));
    away.destroy();
    onHeading.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

`web/src/cm/livePreview.ts`:
```ts
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

const HIDDEN_MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'QuoteMark',
]);

const hideMark = Decoration.replace({});

function selectionTouchesLines(view: EditorView, from: number, to: number): boolean {
  const fromLine = view.state.doc.lineAt(from);
  const toLine = view.state.doc.lineAt(Math.min(to, view.state.doc.length));
  for (const r of view.state.selection.ranges) {
    if (r.from <= toLine.to && r.to >= fromLine.from) return true;
  }
  return false;
}

export function buildHideDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (!HIDDEN_MARKS.has(node.name)) return;
        if (selectionTouchesLines(view, node.from, node.to)) return;
        let end = node.to;
        // HeaderMark: also swallow the single space after `#`
        if (node.name === 'HeaderMark' && view.state.doc.sliceString(end, end + 1) === ' ') end += 1;
        builder.add(node.from, end, hideMark);
      },
    });
  }
  return builder.finish();
}

export const livePreview: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHideDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildHideDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
```
EditorPane: add imports (`languages` from `@codemirror/language-data`, `livePreview` from `../cm/livePreview`), change `markdown({ base: markdownLanguage })` → `markdown({ base: markdownLanguage, codeLanguages: languages })`, and append `livePreview` after `cmTheme` in the extensions array.

- [ ] **Step 4: Run to verify pass** — new tests + full suite + typecheck green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): live-preview mark hiding and fenced-code languages"`

---

### Task 4: Live preview — wikilinks, tags, and [[ autocomplete

**Files:**
- Create: `web/src/cm/wikilinkPlugin.ts`
- Modify: `web/src/components/EditorPane.tsx` (new optional props `onOpenLink`, `noteNames`), `web/src/App.tsx` (pass them), `web/src/theme.css` (append block)
- Test: `web/test/wikilinkPlugin.test.ts`

**Interfaces:**
- Consumes: `resolveLink` (T2) at the App layer — the CM plugin itself only knows raw targets
- Produces:
  - `openLinkEffect`/`wikilinkExtensions(opts: { onOpen(target: string): void; noteNames(): string[] }): Extension[]` — factory returning: (a) a ViewPlugin decorating `[[...]]` spans with `class="cm-wikilink"` mark decorations and hiding the `[[`/`]]`/`|alias` syntax (showing only label) when the selection is not on the link's line; (b) a `EditorView.domEventHandlers` mousedown handler: clicking a `.cm-wikilink` with plain left click calls `onOpen(rawTarget)`; (c) an `@codemirror/autocomplete` source: typing `[[` offers `noteNames()` (note paths without `.md`), inserting `Target]]`
  - Tag decoration: `#tag` tokens get `class="cm-tag"` (mark decoration, regex `(?:^|\s)#([A-Za-z0-9_][\w/-]*)` on visible text, skipping when inside code)
  - EditorPane: optional props `onOpenLink?(target: string): void` and `noteNames?: string[]` (held in refs); when provided, `wikilinkExtensions` + `autocompletion()` are included
  - App: passes `onOpenLink={(t) => { const r = tree && resolveLink(tree, t); if (r) void editor.open(r); }}` and `noteNames` computed from the tree (notes only, paths without `.md`)
- Behavior contract: `[[Other Note]]` renders as an accent-colored clickable "Other Note" without brackets when the cursor is elsewhere; brackets reappear on the active line; clicking navigates; typing `[[` pops completions.

- [ ] **Step 1: Write the failing tests**

`web/test/wikilinkPlugin.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { buildWikilinkDecorations, wikilinkExtensions } from '../src/cm/wikilinkPlugin';

function viewWith(doc: string, cursor: number, onOpen = vi.fn()): { view: EditorView; onOpen: ReturnType<typeof vi.fn> } {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), wikilinkExtensions({ onOpen, noteNames: () => ['Other', 'Deep/Note'] })],
  });
  return { view: new EditorView({ state, parent: document.body }), onOpen };
}

describe('wikilink plugin', () => {
  it('marks wikilinks and hides brackets when cursor elsewhere', () => {
    const { view } = viewWith('go to [[Other]] now\nsecond line', 25);
    const decos = buildWikilinkDecorations(view, () => ['Other']);
    let marks = 0;
    let hidden = 0;
    decos.between(0, view.state.doc.length, (_f, _t, d) => {
      const spec = d.spec as { class?: string };
      if (spec.class?.includes('cm-wikilink')) marks++;
      else hidden++;
    });
    expect(marks).toBeGreaterThanOrEqual(1);
    expect(hidden).toBeGreaterThanOrEqual(2); // [[ and ]]
    view.destroy();
  });

  it('reveals brackets on the active line', () => {
    const { view } = viewWith('go to [[Other]] now', 8);
    const decos = buildWikilinkDecorations(view, () => ['Other']);
    let hidden = 0;
    decos.between(0, view.state.doc.length, (_f, _t, d) => {
      if (!(d.spec as { class?: string }).class) hidden++;
    });
    expect(hidden).toBe(0);
    view.destroy();
  });

  it('marks tags', () => {
    const { view } = viewWith('text #mytag more\nline2', 20);
    const decos = buildWikilinkDecorations(view, () => []);
    let tag = 0;
    decos.between(0, view.state.doc.length, (_f, _t, d) => {
      if ((d.spec as { class?: string }).class?.includes('cm-tag')) tag++;
    });
    expect(tag).toBe(1);
    view.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

`web/src/cm/wikilinkPlugin.ts` (reference implementation — latitude clause applies, contract + tests binding):
```ts
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

const WIKI = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
const TAG = /(^|\s)#([A-Za-z0-9_][\w/-]*)/g;

export interface WikilinkOpts {
  onOpen(target: string): void;
  noteNames(): string[];
}

function lineTouched(view: EditorView, from: number, to: number): boolean {
  const line = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(Math.min(to, view.state.doc.length));
  return view.state.selection.ranges.some((r) => r.from <= endLine.to && r.to >= line.from);
}

export function buildWikilinkDecorations(view: EditorView, _names: () => string[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const found: { f: number; t: number; d: Decoration }[] = [];
    for (const m of text.matchAll(WIKI)) {
      const start = from + m.index!;
      const end = start + m[0].length;
      const target = m[1]!.trim();
      const active = lineTouched(view, start, end);
      const labelStart = m[3] !== undefined ? start + m[0].indexOf('|') + 1 : start + 2;
      const labelEnd = end - 2;
      if (!active) {
        found.push({ f: start, t: labelStart, d: Decoration.replace({}) });
        found.push({
          f: labelStart,
          t: labelEnd,
          d: Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-target': target } }),
        });
        found.push({ f: labelEnd, t: end, d: Decoration.replace({}) });
      } else {
        found.push({
          f: start,
          t: end,
          d: Decoration.mark({ class: 'cm-wikilink cm-wikilink-active', attributes: { 'data-target': target } }),
        });
      }
    }
    for (const m of text.matchAll(TAG)) {
      const start = from + m.index! + m[1]!.length;
      found.push({
        f: start,
        t: start + 1 + m[2]!.length,
        d: Decoration.mark({ class: 'cm-tag' }),
      });
    }
    found.sort((a, b) => a.f - b.f || a.t - b.t);
    for (const { f, t, d } of found) builder.add(f, t, d);
  }
  return builder.finish();
}

export function wikilinkExtensions(opts: WikilinkOpts): Extension[] {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildWikilinkDecorations(view, opts.noteNames);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = buildWikilinkDecorations(u.view, opts.noteNames);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const click = EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest('.cm-wikilink');
      if (el && e.button === 0 && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const target = (el as HTMLElement).dataset['target'];
        if (target) {
          e.preventDefault();
          opts.onOpen(target);
          return true;
        }
      }
      return false;
    },
  });

  function completions(ctx: CompletionContext): CompletionResult | null {
    const word = ctx.matchBefore(/\[\[[^\]]*/);
    if (!word) return null;
    return {
      from: word.from + 2,
      options: opts.noteNames().map((n) => ({ label: n, apply: `${n}]]` })),
      validFor: /^[^\]]*$/,
    };
  }

  return [plugin, click, autocompletion({ override: [completions] })];
}
```
EditorPane: add optional props `onOpenLink?: (target: string) => void; noteNames?: string[];` — hold both in refs; when `onOpenLink` provided, spread `...wikilinkExtensions({ onOpen: (t) => onOpenLinkRef.current?.(t), noteNames: () => noteNamesRef.current ?? [] })` into the extensions.
App: compute `const noteNames = useMemo(() => { const out: string[] = []; const walk = (n: TreeNode) => { if (n.type === 'note') out.push(n.path.replace(/\.md$/, '')); (n.children ?? []).forEach(walk); }; if (tree) walk(tree); return out; }, [tree]);` and pass `onOpenLink` + `noteNames` to EditorPane.
theme.css append:
```css
/* Task 3-4: wikilinks & tags in editor */
.cm-wikilink { color: var(--accent); cursor: pointer; }
.cm-wikilink:hover { text-decoration: underline; }
.cm-tag { color: var(--accent); background: var(--bg-hover); border-radius: 8px; padding: 0 6px; }
```

- [ ] **Step 4: Run to verify pass**; full suite + typecheck green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): live-preview wikilinks, tags, and autocomplete"`

---

### Task 5: Live preview — checkboxes, images, inline math

**Files:**
- Create: `web/src/cm/inlineWidgets.ts`
- Modify: `web/src/components/EditorPane.tsx` (include extension), `web/src/theme.css`
- Test: `web/test/inlineWidgets.test.ts`

**Interfaces:**
- Consumes: katex; EditorPane's `noteNames`-style ref pattern for a `resolveFile(target: string): string | undefined` prop (App supplies `resolveLink` against the tree, returning vault paths for image embeds)
- Produces: `inlineWidgets(opts: { resolveFile(target: string): string | undefined }): Extension` with:
  - **Checkboxes:** lezer `TaskMarker` nodes (`[ ]`/`[x]`) replaced by a `CheckboxWidget` (an `<input type="checkbox" class="cm-checkbox">`) on ALL lines (Obsidian keeps these interactive even on the active line); clicking toggles the underlying text between `[ ]` and `[x]` via a dispatched change (widget carries its doc position; `eq` compares checked state)
  - **Inline math:** `$...$` spans (regex `\$([^$\n]+)\$`, not `$$`) replaced by a KaTeX-rendered widget (`katex.renderToString(src, { throwOnError: false })`) when the selection is not on that line
  - **Images:** `![alt](url)` and `![[embed]]` — when the selection is not on that line, an `ImageWidget` block-side widget is added AFTER the line (Decoration.widget side 1) rendering `<img class="cm-image">` with src = raw url for http(s), else `/api/file/<encodePath(resolveFile(target))>`; unresolvable targets render nothing
- Behavior contract: checkbox click flips the markdown text (and therefore triggers the normal onChange/autosave path); math renders as KaTeX; images preview under their line.

- [ ] **Step 1: Write the failing tests**

`web/test/inlineWidgets.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { inlineWidgets } from '../src/cm/inlineWidgets';

function viewWith(doc: string, cursor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      markdown({ base: markdownLanguage }),
      inlineWidgets({ resolveFile: (t) => (t === 'pic.png' ? 'sub/pic.png' : undefined) }),
    ],
  });
  const view = new EditorView({ state, parent: document.body });
  ensureSyntaxTree(view.state, doc.length, 5000);
  // force a decoration recompute now that the tree is available
  view.dispatch({ selection: EditorSelection.cursor(cursor) });
  return view;
}

describe('inline widgets', () => {
  it('renders checkbox inputs for task markers and toggles on click', () => {
    const view = viewWith('- [ ] buy milk\n\nelsewhere', 20);
    const box = view.dom.querySelector<HTMLInputElement>('input.cm-checkbox');
    expect(box).toBeTruthy();
    box!.click();
    expect(view.state.doc.toString()).toContain('- [x] buy milk');
    view.destroy();
  });

  it('renders inline math via katex when cursor elsewhere', () => {
    const view = viewWith('energy $e=mc^2$ here\n\nx', 24);
    expect(view.dom.querySelector('.katex')).toBeTruthy();
    view.destroy();
  });

  it('shows raw math source on the active line', () => {
    const view = viewWith('energy $e=mc^2$ here', 3);
    expect(view.dom.querySelector('.katex')).toBeFalsy();
    view.destroy();
  });

  it('adds image widgets below lines with embeds', () => {
    const view = viewWith('![[pic.png]]\n\nelsewhere', 16);
    const img = view.dom.querySelector<HTMLImageElement>('img.cm-image');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('/api/file/sub/pic.png');
    view.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

`web/src/cm/inlineWidgets.ts` (reference implementation; latitude clause applies):
```ts
import katex from 'katex';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { encodePath } from '../api';

const INLINE_MATH = /(?<!\$)\$([^$\n]+)\$(?!\$)/g;
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
const EMBED = /!\[\[([^\]\n]+)\]\]/g;

class CheckboxWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private pos: number,
  ) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-checkbox';
    box.checked = this.checked;
    box.onclick = (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? '[ ]' : '[x]' },
      });
    };
    return box;
  }
  override ignoreEvent() {
    return true;
  }
}

class MathWidget extends WidgetType {
  constructor(private src: string) {
    super();
  }
  override eq(other: MathWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const span = document.createElement('span');
    span.innerHTML = katex.renderToString(this.src, { throwOnError: false });
    return span;
  }
}

class ImageWidget extends WidgetType {
  constructor(private src: string) {
    super();
  }
  override eq(other: ImageWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-image';
    img.src = this.src;
    return img;
  }
}

function lineTouched(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  return view.state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
}

export function inlineWidgets(opts: { resolveFile(target: string): string | undefined }): Extension {
  function build(view: EditorView): DecorationSet {
    const entries: { f: number; t: number; d: Decoration }[] = [];
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: (node) => {
          if (node.name === 'TaskMarker') {
            const checked = /x/i.test(view.state.doc.sliceString(node.from, node.to));
            entries.push({
              f: node.from,
              t: node.to,
              d: Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }),
            });
          }
        },
      });
      const text = view.state.doc.sliceString(from, to);
      for (const m of text.matchAll(INLINE_MATH)) {
        const start = from + m.index!;
        if (lineTouched(view, start)) continue;
        entries.push({
          f: start,
          t: start + m[0].length,
          d: Decoration.replace({ widget: new MathWidget(m[1]!) }),
        });
      }
      const addImage = (start: number, matchLen: number, rawTarget: string) => {
        if (lineTouched(view, start)) return;
        const isUrl = /^https?:\/\//.test(rawTarget);
        const resolved = isUrl ? rawTarget : opts.resolveFile(rawTarget);
        if (!resolved) return;
        const src = isUrl ? resolved : `/api/file/${encodePath(resolved)}`;
        const line = view.state.doc.lineAt(start);
        entries.push({
          f: line.to,
          t: line.to,
          d: Decoration.widget({ widget: new ImageWidget(src), side: 1, block: false }),
        });
      };
      for (const m of text.matchAll(MD_IMAGE)) addImage(from + m.index!, m[0].length, m[2]!.trim());
      for (const m of text.matchAll(EMBED)) addImage(from + m.index!, m[0].length, m[1]!.trim());
    }
    entries.sort((a, b) => a.f - b.f || a.t - b.t);
    const builder = new RangeSetBuilder<Decoration>();
    for (const { f, t, d } of entries) builder.add(f, t, d);
    return builder.finish();
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
```
EditorPane: new optional prop `resolveFile?: (target: string) => string | undefined` (ref-held); include `inlineWidgets({ resolveFile: (t) => resolveFileRef.current?.(t) })` in extensions. App passes `resolveFile={(t) => (tree ? resolveLink(tree, t) : undefined)}`.
theme.css append:
```css
/* Task 3-5: inline widgets */
.cm-checkbox { accent-color: var(--accent); margin-right: 4px; }
.cm-image { max-width: min(100%, 480px); display: block; margin: 4px 0; border-radius: 4px; }
```

- [ ] **Step 4: Run to verify pass**; full suite + typecheck green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): live-preview checkboxes, images, and inline math"`

---

### Task 6: Live preview — block math, mermaid, and callout styling

**Files:**
- Create: `web/src/cm/blockWidgets.ts`
- Modify: `web/src/components/EditorPane.tsx`, `web/src/theme.css`
- Test: `web/test/blockWidgets.test.ts`

**Interfaces:**
- Consumes: katex; mermaid (lazy)
- Produces: `blockWidgets: Extension`:
  - **Block math:** `$$...$$` regions (regex `\$\$([\s\S]+?)\$\$`) — when no selection line overlaps the region, `Decoration.replace` over the full range with a KaTeX `displayMode` widget
  - **Mermaid:** fenced code blocks whose info string is `mermaid` (lezer `FencedCode` with `CodeInfo` text `mermaid`) — when not touched, replaced by a `MermaidWidget` that renders asynchronously into its container via lazy `import('mermaid')` (dark theme, `startOnLoad: false`); render errors leave an error message element
  - **Callouts:** lines inside a blockquote whose first line matches `[!type]` get `Decoration.line({ class: 'cm-callout cm-callout-<type>' })` (styling only — text stays editable)
- Behavior contract: `$$…$$` renders as display math when the cursor is outside it; a ```mermaid fence renders as a diagram; `> [!note]` quote lines are visually distinct; clicking/entering any of these reveals the source.

- [ ] **Step 1: Write the failing tests**

`web/test/blockWidgets.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { blockWidgets } from '../src/cm/blockWidgets';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg class="mermaid-test"></svg>' }),
  },
}));

function viewWith(doc: string, cursor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), blockWidgets],
  });
  const view = new EditorView({ state, parent: document.body });
  ensureSyntaxTree(view.state, doc.length, 5000);
  view.dispatch({ selection: EditorSelection.cursor(cursor) });
  return view;
}

describe('block widgets', () => {
  it('renders block math as display katex when cursor outside', () => {
    const doc = 'before\n\n$$\\sum i$$\n\nafter';
    const view = viewWith(doc, 0);
    expect(view.dom.querySelector('.katex-display')).toBeTruthy();
    view.destroy();
  });

  it('shows raw block math when cursor inside', () => {
    const doc = 'before\n\n$$\\sum i$$\n\nafter';
    const view = viewWith(doc, 10);
    expect(view.dom.querySelector('.katex-display')).toBeFalsy();
    view.destroy();
  });

  it('replaces mermaid fences with an async-rendered container', async () => {
    const doc = 'x\n\n```mermaid\ngraph TD; A-->B;\n```\n\ny';
    const view = viewWith(doc, 0);
    expect(view.dom.querySelector('.cm-mermaid')).toBeTruthy();
    await vi.waitFor(() => expect(view.dom.querySelector('.mermaid-test')).toBeTruthy());
    view.destroy();
  });

  it('adds callout line classes', () => {
    const doc = '> [!note] hi\n> body\n\nx';
    const view = viewWith(doc, doc.length);
    expect(view.dom.querySelector('.cm-callout')).toBeTruthy();
    view.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

`web/src/cm/blockWidgets.ts` (reference implementation; latitude clause applies):
```ts
import katex from 'katex';
import { syntaxTree } from '@codemirror/language';
import { type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

const BLOCK_MATH = /\$\$([\s\S]+?)\$\$/g;
const CALLOUT_HEAD = /^>\s*\[!(\w+)\]/;

let mermaidSeq = 0;

class BlockMathWidget extends WidgetType {
  constructor(private src: string) {
    super();
  }
  override eq(other: BlockMathWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const div = document.createElement('div');
    div.innerHTML = katex.renderToString(this.src, { throwOnError: false, displayMode: true });
    return div;
  }
}

class MermaidWidget extends WidgetType {
  constructor(private src: string) {
    super();
  }
  override eq(other: MermaidWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-mermaid';
    const src = this.src;
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      try {
        const { svg } = await mermaid.render(`cmmd-${mermaidSeq++}`, src);
        div.innerHTML = svg;
      } catch {
        div.textContent = 'mermaid render error';
      }
    });
    return div;
  }
}

function regionTouched(view: EditorView, from: number, to: number): boolean {
  const fromLine = view.state.doc.lineAt(from);
  const toLine = view.state.doc.lineAt(Math.min(to, view.state.doc.length));
  return view.state.selection.ranges.some((r) => r.from <= toLine.to && r.to >= fromLine.from);
}

function build(view: EditorView): DecorationSet {
  const entries: { f: number; t: number; d: Decoration }[] = [];
  const doc = view.state.doc;
  const text = doc.toString();

  for (const m of text.matchAll(BLOCK_MATH)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (regionTouched(view, start, end)) continue;
    entries.push({ f: start, t: end, d: Decoration.replace({ widget: new BlockMathWidget(m[1]!.trim()), block: false }) });
  }

  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const info = view.state.doc.sliceString(node.from, Math.min(node.from + 20, node.to));
      if (!/^```\s*mermaid/.test(info)) return;
      if (regionTouched(view, node.from, node.to)) return;
      const src = view.state.doc
        .sliceString(node.from, node.to)
        .replace(/^```\s*mermaid\s*\n?/, '')
        .replace(/\n?```\s*$/, '');
      entries.push({ f: node.from, t: node.to, d: Decoration.replace({ widget: new MermaidWidget(src), block: false }) });
    },
  });

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (!line.text.startsWith('>')) continue;
    // find the head of this quote run
    let headIdx = i;
    while (headIdx > 1 && doc.line(headIdx - 1).text.startsWith('>')) headIdx--;
    const head = doc.line(headIdx);
    const m = CALLOUT_HEAD.exec(head.text);
    if (!m) continue;
    entries.push({
      f: line.from,
      t: line.from,
      d: Decoration.line({ class: `cm-callout cm-callout-${m[1]!.toLowerCase()}` }),
    });
  }

  entries.sort((a, b) => a.f - b.f || a.t - b.t);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { f, t, d } of entries) builder.add(f, t, d);
  return builder.finish();
}

export const blockWidgets: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
```
(Implementation note honored by the reference: block-spanning `Decoration.replace` with `block: false` over multi-line ranges is accepted by CM6 when the range covers whole lines' content; if CM rejects a specific shape at runtime, the latitude clause allows switching to `block: true` widget replacement — tests are the contract.)
EditorPane: append `blockWidgets` to extensions.
theme.css append:
```css
/* Task 3-6: block widgets */
.cm-mermaid { display: flex; justify-content: center; padding: 8px 0; }
.cm-mermaid svg { max-width: 100%; }
.cm-callout { background: var(--bg-hover); border-left: 3px solid var(--accent); }
.cm-callout-warning, .cm-callout-caution { border-left-color: var(--warn); }
.cm-callout-danger, .cm-callout-error, .cm-callout-bug { border-left-color: var(--danger); }
```

- [ ] **Step 4: Run to verify pass**; full suite + typecheck green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): live-preview block math, mermaid, and callouts"`

---

### Task 7: Search overlay and quick switcher

**Files:**
- Create: `web/src/components/SearchOverlay.tsx`
- Modify: `web/src/App.tsx`, `web/src/theme.css`
- Test: `web/test/searchoverlay.test.tsx`

**Interfaces:**
- Consumes: `api.search`, tree note paths
- Produces:
  - `SearchOverlay({ mode, notePaths, onOpen, onClose })` — `mode: 'switcher' | 'search'`. Modal overlay (`.overlay-backdrop` > `.overlay-panel`) with an autofocused input, results list, ArrowUp/Down selection, Enter opens the selected result, Escape closes, clicking the backdrop closes. Switcher: client-side subsequence fuzzy match over `notePaths` (rank: match-start earliest, then shortest path), max 20. Search: `api.search(q)` debounced 250 ms, results show `title` and `path`.
  - App: `overlay: 'switcher' | 'search' | null` state; global keydown adds Ctrl/Cmd+P → switcher and Ctrl/Cmd+Shift+F → search (preventDefault both); `onOpen` = `editor.open` + close overlay.
- Behavior contract: Ctrl+P → type → Enter opens the best match; Ctrl+Shift+F full-text searches via the server; Escape always closes.

- [ ] **Step 1: Write the failing tests**

`web/test/searchoverlay.test.tsx`:
```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchOverlay } from '../src/components/SearchOverlay';
import { api } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return { ...actual, api: { ...actual.api, search: vi.fn() } };
});

const paths = ['Daily/2026-08-26.md', 'Projects/Noteviewer.md', 'Inbox.md'];

beforeEach(() => vi.mocked(api.search).mockReset());

describe('SearchOverlay switcher', () => {
  it('fuzzy filters and opens on Enter', () => {
    const onOpen = vi.fn();
    render(<SearchOverlay mode="switcher" notePaths={paths} onOpen={onOpen} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'notev' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('Projects/Noteviewer.md');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<SearchOverlay mode="switcher" notePaths={paths} onOpen={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SearchOverlay search', () => {
  it('debounces api.search and lists results', async () => {
    vi.useFakeTimers();
    vi.mocked(api.search).mockResolvedValue([{ path: 'Inbox.md', title: 'Inbox', score: 1 }]);
    render(<SearchOverlay mode="search" notePaths={[]} onOpen={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'inbox' } });
    expect(api.search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(api.search).toHaveBeenCalledWith('inbox');
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText('Inbox')).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

`web/src/components/SearchOverlay.tsx`:
```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchResult } from '@noteviewer/shared';
import { api } from '../api';

export interface SearchOverlayProps {
  mode: 'switcher' | 'search';
  notePaths: string[];
  onOpen(path: string): void;
  onClose(): void;
}

function fuzzy(q: string, s: string): number {
  const query = q.toLowerCase();
  const target = s.toLowerCase();
  let qi = 0;
  let first = -1;
  for (let i = 0; i < target.length && qi < query.length; i++) {
    if (target[i] === query[qi]) {
      if (first < 0) first = i;
      qi++;
    }
  }
  if (qi < query.length) return -1;
  return first * 1000 + s.length;
}

export function SearchOverlay({ mode, notePaths, onOpen, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [remote, setRemote] = useState<SearchResult[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const results = useMemo<{ path: string; label: string; sub?: string }[]>(() => {
    if (mode === 'switcher') {
      if (!query.trim()) return notePaths.slice(0, 20).map((p) => ({ path: p, label: p }));
      return notePaths
        .map((p) => ({ p, score: fuzzy(query, p) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => a.score - b.score)
        .slice(0, 20)
        .map((x) => ({ path: x.p, label: x.p }));
    }
    return remote.map((r) => ({ path: r.path, label: r.title, sub: r.path }));
  }, [mode, query, notePaths, remote]);

  useEffect(() => {
    if (mode !== 'search') return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setRemote([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void api.search(query).then(setRemote).catch(() => {});
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mode, query]);

  useEffect(() => setSelected(0), [query]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      const r = results[selected];
      if (r) onOpen(r.path);
    }
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={mode === 'switcher' ? 'Jump to note…' : 'Search vault…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="overlay-results">
          {results.map((r, i) => (
            <li key={r.path} className={i === selected ? 'selected' : ''}>
              <button onClick={() => onOpen(r.path)}>
                {r.label}
                {r.sub && <span className="overlay-sub">{r.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```
App: `const [overlay, setOverlay] = useState<'switcher' | 'search' | null>(null);` extend the existing global keydown handler with Ctrl/Cmd+P (`setOverlay('switcher')`) and Ctrl/Cmd+Shift+F (`setOverlay('search')`), both preventDefault; render at the root:
```tsx
      {overlay && (
        <SearchOverlay
          mode={overlay}
          notePaths={notePaths.map((n) => `${n}.md`)}
          onOpen={(p) => { setOverlay(null); void editor.open(p); }}
          onClose={() => setOverlay(null)}
        />
      )}
```
theme.css append:
```css
/* Task 3-7: overlays */
.overlay-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 20; display: flex; justify-content: center; padding-top: 12vh; }
.overlay-panel { width: min(560px, 92vw); max-height: 60vh; background: var(--bg-deep); border: 1px solid var(--border); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; }
.overlay-panel input { background: var(--bg); color: var(--text); border: 1px solid var(--accent); border-radius: 4px; padding: 8px 10px; font: inherit; }
.overlay-results { list-style: none; margin: 8px 0 0; padding: 0; overflow-y: auto; }
.overlay-results li button { display: block; width: 100%; text-align: left; padding: 6px 10px; }
.overlay-results li.selected button { background: var(--bg-active); }
.overlay-sub { color: var(--text-muted); margin-left: 8px; font-size: 12px; }
```

- [ ] **Step 4: Run to verify pass**; full suite + typecheck green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): quick switcher and full-text search overlay"`

---

### Task 8: Right panel — backlinks and outline

**Files:**
- Modify: `web/src/hooks/useNoteEditor.ts` (keep `headings` in state), `web/src/App.tsx`, `web/src/theme.css`
- Create: `web/src/components/RightPanel.tsx`
- Test: `web/test/rightpanel.test.tsx` (+ 1 hook-state assertion added to `useNoteEditor.test.ts`)

**Interfaces:**
- Consumes: `NoteResponse.meta.headings` (already returned by the server), `editor.state.backlinks`, EditorPane's ref handle
- Produces:
  - `useNoteEditor` state gains `headings: Heading[]` (set in `open`, refreshed in `external` both branches; empty on clear)
  - `RightPanel({ backlinks, headings, onOpenNote, onJumpToHeading })` — two sections: "Backlinks" (buttons per path → `onOpenNote`) and "Outline" (buttons indented by level → `onJumpToHeading(heading)`)
  - App: `panelOpen` state + topbar toggle button (`aria-label="Toggle right panel"`); `onJumpToHeading` scans the editor doc for the first line matching `^#{level}\s+text` via the EditorPane ref's `view` and dispatches a cursor+scrollIntoView selection
- Behavior contract: panel toggles; backlink click navigates; outline click scrolls the editor to that heading.

- [ ] **Step 1: Tests**

`web/test/rightpanel.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RightPanel } from '../src/components/RightPanel';

describe('RightPanel', () => {
  it('lists backlinks and outline, wiring both callbacks', () => {
    const onOpen = vi.fn();
    const onJump = vi.fn();
    render(
      <RightPanel
        backlinks={['a.md', 'sub/b.md']}
        headings={[
          { level: 1, text: 'Top' },
          { level: 2, text: 'Sub' },
        ]}
        onOpenNote={onOpen}
        onJumpToHeading={onJump}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'sub/b.md' }));
    expect(onOpen).toHaveBeenCalledWith('sub/b.md');
    fireEvent.click(screen.getByRole('button', { name: 'Sub' }));
    expect(onJump).toHaveBeenCalledWith({ level: 2, text: 'Sub' });
  });
});
```
Add to `useNoteEditor.test.ts` (in the `open` test): mock note meta with `headings: [{ level: 1, text: 'T' }]` and assert `result.current.state.headings` equals it.

- [ ] **Step 2: verify failure.**

- [ ] **Step 3: Implement**

Hook: add `headings: Heading[]` to `NoteEditorState` (+ `import type { Heading } from '@noteviewer/shared'`), default `[]` in `EMPTY`; in `open` and both non-echo branches of `external` set `headings: note.meta.headings`; echo branch refreshes it too alongside title/backlinks.

`web/src/components/RightPanel.tsx`:
```tsx
import type { Heading } from '@noteviewer/shared';

export interface RightPanelProps {
  backlinks: string[];
  headings: Heading[];
  onOpenNote(path: string): void;
  onJumpToHeading(h: Heading): void;
}

export function RightPanel({ backlinks, headings, onOpenNote, onJumpToHeading }: RightPanelProps) {
  return (
    <aside className="right-panel">
      <h3>Backlinks</h3>
      {backlinks.length === 0 && <div className="panel-empty">No backlinks</div>}
      {backlinks.map((b) => (
        <button key={b} className="panel-item" onClick={() => onOpenNote(b)}>
          {b}
        </button>
      ))}
      <h3>Outline</h3>
      {headings.length === 0 && <div className="panel-empty">No headings</div>}
      {headings.map((h, i) => (
        <button
          key={`${h.level}-${h.text}-${i}`}
          className="panel-item"
          style={{ paddingLeft: `${8 + (h.level - 1) * 12}px` }}
          onClick={() => onJumpToHeading(h)}
        >
          {h.text}
        </button>
      ))}
    </aside>
  );
}
```
App: `panelOpen` state, toggle button in topbar (`aria-label="Toggle right panel"`); `const editorRef = useRef<EditorPaneHandle>(null);` passed to EditorPane; render panel after `<main>`:
```tsx
      {panelOpen && (
        <RightPanel
          backlinks={editor.state.backlinks}
          headings={editor.state.headings}
          onOpenNote={(p) => void editor.open(p)}
          onJumpToHeading={(h) => {
            const view = editorRef.current?.view;
            if (!view) return;
            const re = new RegExp(`^#{${h.level}}\\s+${h.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
            for (let i = 1; i <= view.state.doc.lines; i++) {
              const line = view.state.doc.line(i);
              if (re.test(line.text)) {
                view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
                view.focus();
                break;
              }
            }
          }}
        />
      )}
```
theme.css append:
```css
/* Task 3-8: right panel */
.right-panel { width: 240px; flex-shrink: 0; border-left: 1px solid var(--border); background: var(--bg-deep); overflow-y: auto; padding: 8px 0; }
.right-panel h3 { margin: 8px 12px 4px; font-size: 12px; text-transform: uppercase; color: var(--text-muted); }
.panel-item { display: block; width: 100%; text-align: left; padding: 3px 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-item:hover { color: var(--text); background: var(--bg-hover); }
.panel-empty { color: var(--text-muted); font-size: 12px; padding: 2px 12px; }
@media (max-width: 768px) { .right-panel { display: none; } }
```

- [ ] **Step 4: verify pass; full suite + typecheck green.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): backlinks and outline right panel"`

---

### Task 9: Kanban board view

**Files:**
- Create: `web/src/kanban.ts` (parse/serialize), `web/src/components/KanbanBoard.tsx`
- Modify: `web/src/App.tsx`, `web/src/theme.css`
- Test: `web/test/kanban.test.ts`, `web/test/kanbanboard.test.tsx`

**Interfaces:**
- Produces:
  - `isKanbanNote(content: string): boolean` — frontmatter contains `kanban-plugin`
  - `parseKanban(content: string): { frontmatter: string; columns: { title: string; items: { text: string; done: boolean }[] }[]; trailer: string }` — `## headings` are columns, `- [ ]`/`- [x]` list items are cards; `trailer` preserves any obsidian-kanban settings block (`%% kanban:settings … %%`) verbatim
  - `serializeKanban(parsed): string` — round-trips: frontmatter + blank line + per column `## Title\n\n` + `- [ ] text` lines + trailer; `parseKanban(serializeKanban(p))` is stable
  - `KanbanBoard({ content, onChange })` — renders columns/cards; HTML5 drag-and-drop moves a card between/within columns and calls `onChange(serializeKanban(updated))`; card checkbox toggles done; a `+ Add card` input per column appends an item
  - App: when `isKanbanNote(editor.state.content)` a topbar toggle (`aria-label="Toggle board view"`) switches `boardMode`; board replaces the editor and writes through `editor.handleChange(newMd)` (autosave + conflict guard apply unchanged); `boardMode` resets on `path` change
- Behavior contract: a kanban note renders as a board; dragging a card writes valid obsidian-kanban markdown through the normal save path; the raw-markdown toggle always available.

- [ ] **Step 1: Tests**

`web/test/kanban.test.ts`:
```ts
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
```

`web/test/kanbanboard.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from '../src/components/KanbanBoard';

const doc = '---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] task one\n\n## Done\n\n- [x] shipped\n';

describe('KanbanBoard', () => {
  it('renders columns and cards', () => {
    render(<KanbanBoard content={doc} onChange={() => {}} />);
    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('task one')).toBeTruthy();
    expect(screen.getByText('shipped')).toBeTruthy();
  });

  it('toggling a card checkbox writes updated markdown', () => {
    const onChange = vi.fn();
    render(<KanbanBoard content={doc} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0]![0]).toContain('- [x] task one');
  });

  it('adds a card via the column input', () => {
    const onChange = vi.fn();
    render(<KanbanBoard content={doc} onChange={onChange} />);
    const input = screen.getAllByPlaceholderText('Add card…')[0]!;
    fireEvent.change(input, { target: { value: 'new card' } });
    fireEvent.submit(input.closest('form')!);
    expect(onChange.mock.calls[0]![0]).toContain('- [ ] new card');
  });
});
```

- [ ] **Step 2: verify failure.**

- [ ] **Step 3: Implement**

`web/src/kanban.ts`:
```ts
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
  const frontmatter = fmMatch ? fmMatch[0] : '';
  let body = content.slice(frontmatter.length);
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
      columns[columns.length - 1]!.items.push({ text: item[2]!, done: item[1]!.toLowerCase() === 'x' });
    }
  }
  return { frontmatter, columns, trailer };
}

export function serializeKanban(doc: KanbanDoc): string {
  const cols = doc.columns
    .map((c) => {
      const items = c.items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n');
      return `## ${c.title}\n\n${items}`.trimEnd();
    })
    .join('\n\n');
  const parts = [doc.frontmatter.trimEnd(), '', cols];
  if (doc.trailer) parts.push('', doc.trailer);
  return `${parts.join('\n').replace(/^\n+/, doc.frontmatter ? '' : '\n')}\n`.replace(/\n{4,}/g, '\n\n\n');
}
```
(Round-trip stability is the binding contract — adjust whitespace handling under the latitude clause until the round-trip test passes.)

`web/src/components/KanbanBoard.tsx`:
```tsx
import { useState } from 'react';
import { type KanbanDoc, parseKanban, serializeKanban } from '../kanban';

export interface KanbanBoardProps {
  content: string;
  onChange(md: string): void;
}

export function KanbanBoard({ content, onChange }: KanbanBoardProps) {
  const doc = parseKanban(content);
  const [drag, setDrag] = useState<{ col: number; item: number } | null>(null);

  function commit(next: KanbanDoc) {
    onChange(serializeKanban(next));
  }

  function moveCard(toCol: number, toIndex: number) {
    if (!drag) return;
    const next: KanbanDoc = {
      ...doc,
      columns: doc.columns.map((c) => ({ ...c, items: [...c.items] })),
    };
    const [card] = next.columns[drag.col]!.items.splice(drag.item, 1);
    next.columns[toCol]!.items.splice(toIndex, 0, card!);
    setDrag(null);
    commit(next);
  }

  return (
    <div className="kanban">
      {doc.columns.map((col, ci) => (
        <div
          key={col.title}
          className="kanban-col"
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => moveCard(ci, col.items.length)}
        >
          <div className="kanban-col-title">{col.title}</div>
          {col.items.map((item, ii) => (
            <div
              key={`${item.text}-${ii}`}
              className="kanban-card"
              draggable
              onDragStart={() => setDrag({ col: ci, item: ii })}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.stopPropagation();
                moveCard(ci, ii);
              }}
            >
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => {
                  const next = { ...doc, columns: doc.columns.map((c) => ({ ...c, items: [...c.items] })) };
                  next.columns[ci]!.items[ii] = { ...item, done: !item.done };
                  commit(next);
                }}
              />
              <span className={item.done ? 'kanban-done' : ''}>{item.text}</span>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).elements[0] as HTMLInputElement;
              if (!input.value.trim()) return;
              const next = { ...doc, columns: doc.columns.map((c) => ({ ...c, items: [...c.items] })) };
              next.columns[ci]!.items.push({ text: input.value.trim(), done: false });
              input.value = '';
              commit(next);
            }}
          >
            <input placeholder="Add card…" />
          </form>
        </div>
      ))}
    </div>
  );
}
```
App: `boardMode` state (default true — a kanban note opens as a board), reset on `path` change; topbar toggle button rendered only when `isKanbanNote(editor.state.content)`; view selection order: kanban+boardMode → KanbanBoard (`onChange={(md) => editor.handleChange(md)}` — note the board is derived from `editor.state.content`, so ALSO call a local `setState` refresh: simplest is `onChange={(md) => { editor.handleChange(md); }}` plus rendering the board from the LIVE buffer — pass `content={editor.state.content}` and after handleChange force content refresh via `editor` revision… **Simplification that is the contract:** KanbanBoard keeps no internal copy; App passes `content` and each `onChange` immediately re-renders from the serialized result by ALSO updating hook state — expose this by adding to the hook a `applyLocalContent(md: string): void` method that sets `bufferRef`, `dirty`, schedules autosave AND updates `state.content` (unlike `handleChange`, which deliberately doesn't touch `state.content`). Add it to `useNoteEditor` with a 3-line implementation + 1 test: `applyLocalContent` updates `state.content` and autosaves like `handleChange`.) → else reading/edit views as before.
theme.css append:
```css
/* Task 3-9: kanban */
.kanban { flex: 1; display: flex; gap: 12px; padding: 16px; overflow-x: auto; align-items: flex-start; }
.kanban-col { background: var(--bg-deep); border: 1px solid var(--border); border-radius: 8px; padding: 8px; width: 260px; flex-shrink: 0; }
.kanban-col-title { font-weight: 700; padding: 4px 6px 8px; }
.kanban-card { background: var(--bg-hover); border-radius: 6px; padding: 8px; margin-bottom: 6px; cursor: grab; display: flex; gap: 8px; align-items: baseline; }
.kanban-done { text-decoration: line-through; color: var(--text-muted); }
.kanban input[type='text'], .kanban form input { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; font: inherit; }
```

- [ ] **Step 4: verify pass; full suite + typecheck green.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): kanban board view with markdown round-trip"`

---

### Task 10: Server hardening batch

**Files:**
- Modify: `server/src/routes/vault-routes.ts`, `server/src/vault/watcher.ts`, `server/src/main.ts`, `.github/workflows/docker.yml`
- Test: extend `server/test/routes-notes.test.ts` / `routes-mutations.test.ts`

**Interfaces:** unchanged public API; internal hardening only:
1. SSE route calls `reply.hijack()` before writing raw (Fastify 5 takeover pattern).
2. `VaultBus` constructor calls `this.setMaxListeners(0)`.
3. `main.ts`: SIGTERM/SIGINT handler → `await app.close(); process.exit(0);` (register once, both signals).
4. `relParam` wraps `decodeURIComponent` in try/catch — on `URIError` return a sentinel the routes treat as bad path (404) — test: `GET /api/note/50%.md` → 404, not 500.
5. GET `/api/note/*`: treat `EISDIR` like ENOENT → 404 — test: create dir `sub`, `GET /api/note/sub` → 404. (Note the hidden/non-md guard already 404s `sub` for missing `.md`; use a directory literally named `dir.md` to reach the EISDIR path.)
6. Workflow: bump `actions/checkout@v4` → `@v5` and `actions/setup-node@v4` → `@v5`.

- [ ] **Step 1: Write the failing tests** (malformed percent-encoding; `dir.md`-directory EISDIR) in the existing route-test files, following their `appFor` pattern:
```ts
  it('404s on malformed percent-encoding', async () => {
    const { app } = await appFor({});
    expect((await app.inject({ url: '/api/note/50%.md' })).statusCode).toBe(404);
  });

  it('404s when the path is a directory named like a note', async () => {
    const { app } = await appFor({ 'dir.md/inner.md': 'x' });
    expect((await app.inject({ url: '/api/note/dir.md' })).statusCode).toBe(404);
  });
```
- [ ] **Step 2: verify failure** (500s / URIError today).
- [ ] **Step 3: Implement** all six items. SSE hijack shape:
```ts
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { ... unchanged ... });
```
relParam:
```ts
function relParam(params: unknown): string {
  const raw = (params as Record<string, string>)['*'] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '\u0000invalid';
  }
}
```
(the NUL sentinel can never be a real vault path; `badNotePath` gains `rel.includes('\u0000')` as a reject condition, and the file route 404s on it too). EISDIR: add `'EISDIR'` alongside ENOENT checks in the GET handler's catch.
main.ts:
```ts
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
```
- [ ] **Step 4: full suite + typecheck green; also `docker build -t nv-hardening-test . && docker rm -f $(docker create nv-hardening-test) >/dev/null && docker rmi nv-hardening-test` to prove the image still builds.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "fix(server): SSE hijack, graceful shutdown, EISDIR/encoding 404s, CI action bumps"`

---

### Task 11: Web hardening batch

**Files:**
- Modify: `web/src/hooks/useNoteEditor.ts`, `web/src/App.tsx`, `web/index.html`, `package.json` + create `e2e/tsconfig.json`
- Test: extend existing web test files

**Changes (each with a covering test where marked):**
1. **Blur/unload flush (spec gap):** App effect — `visibilitychange` to hidden → `void editor.saveNow()`; `beforeunload` → if `editor.state.dirty`, `e.preventDefault()` (dirty-warning). *(test: dispatch `document.visibilitychange` with hidden mocked → api.save called)*
2. **Drawer auto-close:** `onOpenNote` in the sidebar also `setSidebarOpen(false)`. *(test: open note via tree click after opening drawer → `.app` class no longer `sidebar-open`)*
3. **keepMine polish:** set `saving: true` during its PUT (cleared after), add `clearTimer()` at entry. *(covered by existing keepMine tests still passing + 1 assertion on saving flag mid-flight using a deferred promise)*
4. **open() rejection surfacing:** App wraps tree/backlink/overlay `editor.open` calls in a helper `openNote(p)` that catches and sets `actionError('Failed to open note.')`. *(test: api.note rejects → error strip shown)*
5. **`<meta name="color-scheme" content="dark">`** in `web/index.html`.
6. **inflightRef holder-guard:** in both `save()` and `saveAsCopy()`, `finally` clears `inflightRef` only if it still holds this run's promise (`if (inflightRef.current === p) inflightRef.current = null;`).
7. **e2e typecheck:** `e2e/tsconfig.json` extending base with `types: ["node"]`, include `["*.ts", "../playwright.config.ts"]`; root typecheck script gains `&& tsc -p e2e --noEmit`.

- [ ] **Step 1: tests first for 1, 2, 4 (+3's saving assertion); Step 2: verify failure; Step 3: implement; Step 4: full suite + typecheck green; Step 5: Commit** — `git add -A && git commit -m "fix(web): unload flush, drawer auto-close, open-failure surfacing, hardening"`

---

### Task 12: e2e additions for rich rendering

**Files:**
- Modify: `e2e/prepare-vault.mjs` (add fixture notes), `e2e/app.spec.ts` (append tests)

**Fixtures to add:** `Rich.md` (`# Rich\n\nSome **bold** text with [[Welcome]] and math $x^2$.\n`), `Board.md` (kanban frontmatter + `## Todo` with one card + `## Done`).

**New tests (append):**
```ts
test('reading mode renders formatting and navigates wikilinks', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Rich' }).click();
  await expect(page.locator('.cm-content')).toContainText('bold');
  await page.getByRole('button', { name: 'Toggle reading mode' }).click();
  await expect(page.locator('.reading-view strong')).toHaveText('bold');
  await page.locator('.reading-view a.internal-link').click();
  await expect(page.getByTestId('note-title')).toHaveText('Welcome');
});

test('quick switcher opens notes', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+p');
  await page.getByRole('textbox').fill('rich');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('note-title')).toHaveText('Rich');
});

test('live preview hides heading marks when cursor elsewhere', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Rich' }).click();
  const firstLine = page.locator('.cm-line').first();
  await expect(firstLine).not.toContainText('#');
  await expect(firstLine).toContainText('Rich');
});

test('kanban note renders as a board and drag targets exist', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(page.locator('.kanban-col')).toHaveCount(2);
  await expect(page.locator('.kanban-card')).toHaveCount(1);
});
```
(Reading-mode test note: opening Rich puts the cursor nowhere until click — the live-preview test may need a `.cm-content` click on a lower line first if marks render revealed initially; adjust interaction, not the assertion.)

- [ ] **Steps:** append fixtures + tests → `npm run test:e2e` green (now 8 tests) → full unit suite + typecheck → commit `test(web): e2e coverage for reading mode, switcher, live preview, kanban`.

---

## After this plan

- Merge to main, push; CI publishes the finished app to `ghcr.io/glitchtit/noteviewer:latest`. Unraid deploy: container with that image, `/mnt/user/appdata/obsidian/Obsidian Vault` → `/vault`, port 8080, Cloudflare Zero Trust in front.
- Remaining known deferrals (recorded, out of v1 scope): tabs/split panes, graph view, `[[Note^blockid]]` block-ref rendering (rename-rewrite already handles them), reading-mode interactive checkboxes, per-depth kanban settings fidelity beyond the settings-trailer passthrough, PUID/PGID container user.
