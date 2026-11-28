import { defineConfig } from 'vitest/config';

/**
 * Unit tests drive the engine through a scripted native driver
 * (`tests/helpers/fake-driver.ts`) and captured snapshots, fully in
 * parallel, on any OS. A real desktop session is the desktop testbed's.
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
          // A private os.tmpdir() per test file: see the setup file.
          setupFiles: ['tests/helpers/private-tmpdir.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
    ],
  },
});
