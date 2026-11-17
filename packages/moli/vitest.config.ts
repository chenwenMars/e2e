import { defineConfig } from 'vitest/config';

/** Provider lifecycle tests use a fake executable and need no Moli installation. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
