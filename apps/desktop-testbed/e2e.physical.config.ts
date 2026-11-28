import type { E2EConfig } from 'e2e';
import { desktop } from '@e2e-dev/desktop';
import base from './e2e.config.ts';

/**
 * The physical-input suite: double-click, hover, and a tap at a point, which
 * need the real pointer. It moves your pointer and brings the app forward,
 * so run it by hand, with nothing else to do on the Mac for a few seconds:
 *
 *   pnpm --filter @e2e-dev/desktop-testbed test:physical
 */
export default {
  ...base,
  projectId: 'dev.e2e.desktop-testbed-physical',
  tests: 'tests-physical/**/*.e2e.ts',
  workers: 1,
  targets: [{ ...base.targets[0], engine: desktop({ physicalInput: true }) }],
} satisfies E2EConfig;
