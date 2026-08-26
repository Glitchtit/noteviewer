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
