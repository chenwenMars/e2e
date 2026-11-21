import { defineConfig } from 'vitest/config';

/**
 * Unit tests drive the engine through a scripted agent-desktop binary and
 * captured snapshots, fully in parallel. A real desktop session is the
 * desktop testbed's.
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
    ],
  },
});
