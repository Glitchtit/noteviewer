import { chromium } from 'playwright-core';

export type PdfRenderer = (notePath: string) => Promise<Buffer>;

/**
 * Renders a note to PDF by printing the SPA's `/print` page with headless
 * Chromium — the same print document as the web "Export to PDF" (callouts,
 * KaTeX, Mermaid, embeds; page size and margins from its `@page` rule). `baseUrl` is the private listener on localhost — never the
 * public one. A browser is launched per call: PDFs are rare and this keeps
 * no Chromium resident between them.
 */
export function createPdfRenderer(baseUrl: string): PdfRenderer {
  return async (notePath) => {
    const browser = await chromium.launch({
      executablePath: process.env['CHROMIUM_PATH'] || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/print?path=${encodeURIComponent(notePath)}`);
      await page.waitForFunction(
        () => (window as unknown as { __nvReady?: unknown }).__nvReady !== undefined,
        undefined,
        { timeout: 20_000 },
      );
      const status = await page.evaluate(() => (window as unknown as { __nvReady: string }).__nvReady);
      if (status !== 'ok') throw new Error(`print page failed: ${status}`);
      return await page.pdf({ preferCSSPageSize: true, printBackground: true });
    } finally {
      await browser.close();
    }
  };
}
