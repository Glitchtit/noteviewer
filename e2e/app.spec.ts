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
