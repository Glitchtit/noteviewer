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
    // entity-encoding of '>' is encoder-dependent; assert the mermaid source
    // survives into the code element via a stable substring instead.
    expect(html).toContain('graph TD; A-->B;');
  });

  it('passes raw inline HTML through', async () => {
    const html = await renderMarkdown('a <kbd>Ctrl</kbd> key');
    expect(html).toContain('<kbd>Ctrl</kbd>');
  });
});
