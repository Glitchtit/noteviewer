import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web',
          environment: 'jsdom',
          environmentOptions: { jsdom: { pretendToBeVisual: true } },
          include: ['web/test/**/*.test.{ts,tsx}'],
          setupFiles: ['web/test/setup.ts'],
        },
      },
    ],
  },
});
