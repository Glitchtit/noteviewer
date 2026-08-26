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
