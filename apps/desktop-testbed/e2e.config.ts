import type { E2EConfig } from 'e2e';
import { desktop } from '@e2e-dev/desktop';

/**
 * The desktop testbed: a native AppKit sign-in form driven through the
 * desktop engine's native driver. Build the app once with `pnpm build:app`,
 * and the driver with `pnpm --filter @e2e-dev/desktop build:native`. macOS
 * needs Accessibility permission for the app that starts the run (Terminal,
 * an IDE, a CI agent), and Screen Recording for screenshots.
 */
export const target = {
  name: 'macos',
  engine: desktop(),
  app: { appPath: 'build/SignInForm.app' },
};

export default {
  projectId: 'dev.e2e.desktop-testbed',
  targets: [target],
  credentials: {
    ada: {
      username: 'ada',
      password: 'hunter2',
    },
  },
} satisfies E2EConfig;
