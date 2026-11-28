import { defineConfig } from 'vitest/config';

/**
 * Unit tests project captured Chromium reads and check the options and the
 * protocol client, fully in parallel. Integration tests start real Electron
 * apps, so they need a display: `pnpm test:integration`, under `xvfb-run` on
 * Linux. The Electron testbed runs whole tests on one.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/electron-binary.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
    ],
  },
});
