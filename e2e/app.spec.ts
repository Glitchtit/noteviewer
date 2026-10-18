import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const VAULT = 'e2e/.vault';

test('tree lists notes and opens content', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Welcome' }).click();
  await expect(page.locator('.cm-content')).toContainText('Hello from the fixture vault');
});

test('typing autosaves to disk', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Welcome' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('Autosaved line. ');
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 5000 });
  expect(readFileSync(`${VAULT}/Welcome.md`, 'utf8')).toContain('Autosaved line.');
});

test('external change reloads a clean editor', async ({ page }) => {
  await page.goto('/');
  // Folders start collapsed, so surface sub/Other.md via the expand-all button.
  await page.getByRole('button', { name: 'Expand all folders' }).click();
  await page.getByRole('button', { name: 'Other' }).click();
  await expect(page.locator('.cm-content')).toContainText('Another note');
  writeFileSync(`${VAULT}/sub/Other.md`, '# Other\n\nChanged externally.\n');
  await expect(page.locator('.cm-content')).toContainText('Changed externally', { timeout: 10_000 });
});

test('dirty editor + external change → conflict bar → save as copy', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Welcome' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.locator('.cm-content').click();
  writeFileSync(`${VAULT}/Welcome.md`, '# Welcome\n\nTheirs version.\n');
  await page.keyboard.type('My concurrent edit. ');
  await expect(page.locator('.conflict-bar')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Save as copy' }).click();
  await expect(page.getByTestId('note-title')).toContainText('Welcome-copy', { timeout: 5000 });
  expect(readFileSync(`${VAULT}/Welcome-copy.md`, 'utf8')).toContain('My concurrent edit.');
});

test('reading mode renders formatting and navigates wikilinks', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Rich' }).click();
  await expect(page.locator('.cm-content')).toContainText('bold');
  await page.getByRole('button', { name: 'Toggle reading mode' }).click();
  await expect(page.locator('.reading-view strong')).toHaveText('bold');
  await page.locator('.reading-view a.internal-link').click();
  await expect(page.getByTestId('note-title')).toHaveText('Welcome');
});

test('reload keeps the open note, view mode and scroll position', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Long', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Paragraph line 1.');

  // edit mode: scroll the editor, reload, same top line
  await page.locator('.cm-scroller').hover();
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(400);
  const editTop = await page.locator('.cm-scroller').evaluate((el) => el.scrollTop);
  expect(editTop).toBeGreaterThan(1000);
  await page.reload();
  await expect(page.getByTestId('note-title')).toHaveText('Long');
  await expect
    .poll(() => page.locator('.cm-scroller').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(editTop - 100);

  // reading mode: scroll, reload, back in reading mode at the same spot
  await page.getByRole('button', { name: 'Toggle reading mode' }).click();
  const reading = page.locator('.reading-view');
  await expect(reading).toContainText('Paragraph line 300.');
  await reading.hover();
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(400);
  const readTop = await reading.evaluate((el) => el.scrollTop);
  expect(readTop).toBeGreaterThan(1000);
  await page.reload();
  await expect(page.getByTestId('note-title')).toHaveText('Long');
  await expect(page.locator('.reading-view')).toContainText('Paragraph line 300.');
  await expect.poll(() => page.locator('.reading-view').evaluate((el) => el.scrollTop)).toBe(readTop);
});

test('quick switcher opens notes', async ({ page }) => {
  await page.goto('/');
  // Wait for the app to mount (tree fetched, keydown listener attached)
  // before sending the shortcut — pressing it immediately after goto races
  // the bundle's hydration and the keypress is dropped. Match "Rich" exactly
  // since an earlier test in this run may have left a "Welcome-copy" note.
  await expect(page.getByRole('button', { name: 'Rich', exact: true })).toBeVisible();
  await page.keyboard.press('Control+p');
  await page.getByRole('textbox').fill('rich');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('note-title')).toHaveText('Rich');
});

test('live preview hides heading marks when cursor elsewhere', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Rich' }).click();
  // The editor mounts with the cursor at document start, inside the H1's
  // extent, so the heading marks render revealed until the selection moves
  // off that line — click the last line first so the assertion reflects the
  // steady-state (cursor-elsewhere) behavior the test name describes.
  await page.locator('.cm-line').last().click();
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

test('graph view renders the vault and opens a note from the filter', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Rich', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle graph view' }).click();
  await expect(page.getByTestId('note-title')).toHaveText('Graph');
  await expect(page.getByRole('img', { name: 'Note graph' })).toBeVisible();
  // Fixture vault: Welcome -> sub/Other, Rich -> Welcome.
  await expect(page.getByTestId('graph-status')).toContainText(/\d+ notes · 2 links/);
  await page.getByLabel('Filter graph').fill('rich');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('note-title')).toHaveText('Rich');
  await expect(page.locator('.cm-content')).toContainText('bold');
});

test('drag a note onto a folder moves it on disk', async ({ page, request }) => {
  await request.post('/api/note', { data: { path: 'Movable.md', content: '# Movable\n' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Movable' }).dragTo(page.getByRole('button', { name: /sub/ }));
  // The target folder is expanded after the move so the note stays visible.
  await expect(page.getByRole('button', { name: 'Movable' })).toBeVisible();
  await expect.poll(() => existsSync(`${VAULT}/sub/Movable.md`)).toBe(true);
  expect(existsSync(`${VAULT}/Movable.md`)).toBe(false);
});

test('context menu creates a copy and deletes a note', async ({ page, request }) => {
  await request.post('/api/note', { data: { path: 'Scratch.md', content: 'scratch body\n' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Scratch', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Create copy' }).click();
  await expect(page.getByTestId('note-title')).toHaveText('Scratch-copy');
  expect(readFileSync(`${VAULT}/Scratch-copy.md`, 'utf8')).toBe('scratch body\n');

  await page.getByRole('button', { name: 'Scratch', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('menuitem', { name: 'Really delete?' }).click();
  await expect(page.getByRole('button', { name: 'Scratch', exact: true })).toHaveCount(0);
  expect(existsSync(`${VAULT}/Scratch.md`)).toBe(false);
});

test('share: public link works on the public port only, then revokes', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Rich' }).click();
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('button', { name: 'Create link' }).click();
  const link = page.getByTestId('share-link').locator('input');
  await expect(link).toHaveValue(/\/s\/[A-Za-z0-9_-]{22}$/);
  const token = (await link.inputValue()).split('/s/')[1]!;

  const visitor = await browser.newPage();
  await visitor.goto(`http://127.0.0.1:8126/s/${token}`);
  await expect(visitor.getByTestId('note-title')).toHaveText('Rich');
  await expect(visitor.locator('.reading-view')).toContainText('Some bold text');
  await expect(visitor.locator('.reading-view .katex')).toBeVisible();
  // wikilinks are inert and the private API is absent on the public port
  await visitor.locator('a.internal-link', { hasText: 'Welcome' }).click();
  await expect(visitor.getByTestId('note-title')).toHaveText('Rich');
  expect((await visitor.request.get('http://127.0.0.1:8126/api/tree')).status()).toBe(404);
  expect((await visitor.request.get('http://127.0.0.1:8126/')).status()).toBe(404);

  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('share-link')).toHaveCount(0);
  await visitor.reload();
  await expect(visitor.getByTestId('share-missing')).toBeVisible();
  await visitor.close();
});

test('share: PDF renders through headless Chromium', async ({ request }) => {
  const res = await request.get('/api/pdf/Rich.md', { timeout: 30_000 });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  const body = await res.body();
  expect(body.subarray(0, 5).toString()).toBe('%PDF-');
  expect(body.length).toBeGreaterThan(5_000);
});
