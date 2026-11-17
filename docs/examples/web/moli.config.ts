import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { moli } from '@e2e-dev/moli';

export default {
  targets: [
    {
      name: 'moli',
      engine: web({ browser: moli() }),
      app: { url: 'http://localhost:3000' },
    },
  ],
} satisfies E2EConfig;
