import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import type { Element, Root } from 'hast';
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

/**
 * Allowlist for model output: the GitHub-style default plus the classes and
 * data attributes our wikilink / callout / math markup needs. No event
 * handlers, scripts, styles or javascript: URLs survive it.
 */
type AttrDef = NonNullable<SanitizeSchema['attributes']>[string][number];
const isClassRule = (d: AttrDef) => (Array.isArray(d) ? d[0] : d) === 'className';
/** default allowance for a tag, minus its value-restricted className rule, plus ours */
function allow(tag: string, extra: string[]): AttrDef[] {
  return [...(defaultSchema.attributes?.[tag] ?? []).filter((d) => !isClassRule(d)), ...extra];
}

const agentSchema: SanitizeSchema = {
  ...defaultSchema,
  // keep ids as written (wikilinks and headings never rely on the user-content- prefix here)
  clobberPrefix: '',
  attributes: {
    ...defaultSchema.attributes,
    '*': allow('*', ['className', 'dataTarget']),
    a: allow('a', ['className', 'dataTarget']),
    img: allow('img', ['className', 'dataTarget']),
    code: allow('code', ['className']),
    ul: allow('ul', ['className']),
    ol: allow('ol', ['className']),
    li: allow('li', ['className']),
    input: allow('input', []),
  },
};

/**
 * Images pointing off the vault would load automatically — a prompt-injected
 * answer could smuggle note contents out in the URL. Show them as plain links.
 */
function rehypeExternalImagesAsLinks() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      for (const [i, child] of node.children.entries()) {
        if (child.type !== 'element') continue;
        const src = child.tagName === 'img' ? String(child.properties?.['src'] ?? '') : '';
        if (src && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
          const alt = String(child.properties?.['alt'] ?? '') || src;
          node.children[i] = {
            type: 'element',
            tagName: 'a',
            properties: { href: src, target: '_blank', rel: ['noopener', 'noreferrer'] },
            children: [{ type: 'text', value: `🖼 ${alt}` }],
          };
        } else visit(child);
      }
    };
    visit(tree);
  };
}

const agentPipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkWikilinks)
  .use(remarkCallouts)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, agentSchema)
  .use(rehypeExternalImagesAsLinks)
  .use(rehypeKatex)
  .use(rehypeStringify);

/** Render untrusted Markdown (the AI agent's answers) safely. */
export async function renderAgentMarkdown(md: string): Promise<string> {
  return String(await agentPipeline.process(md));
}
