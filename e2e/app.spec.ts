import { readFileSync, writeFileSync } from 'node:fs';
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
