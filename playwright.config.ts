import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://127.0.0.1:8125' },
  webServer: {
    command: 'node e2e/prepare-vault.mjs && VAULT_PATH=e2e/.vault PORT=8125 npx tsx server/src/main.ts',
    url: 'http://127.0.0.1:8125/api/tree',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
