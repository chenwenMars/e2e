import type { E2EConfig } from 'e2e';
import { electron } from '@e2e-dev/electron';

/**
 * The Electron testbed: a small Electron app (`app/`) started from the
 * `electron` package installed here, its windows driven through Chromium's
 * accessibility tree. The windows stay hidden unless `E2E_ELECTRON_HEADED=1`:
 * the app reads `E2E_ELECTRON_HIDDEN` and does not show them, and the engine
 * reads and drives a hidden window the same way.
 */
export const target = {
  name: 'electron',
  engine: electron({ env: { E2E_ELECTRON_HIDDEN: process.env.E2E_ELECTRON_HEADED === '1' ? '0' : '1' } }),
  app: { appPath: '.', launchArguments: ['--greeting=Hello from e2e'] },
};

export default {
  projectId: 'dev.e2e.electron-testbed',
  targets: [target],
  credentials: {
    ada: {
      username: 'ada',
      password: 'hunter2',
    },
  },
} satisfies E2EConfig;
