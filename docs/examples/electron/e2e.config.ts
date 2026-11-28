import type { E2EConfig } from 'e2e';
import { electron } from '@e2e-dev/electron';

export default {
  targets: [
    {
      name: 'electron',
      engine: electron(),
      app: { appPath: '.', launchArguments: ['--no-update-check'] },
    },
  ],
  credentials: {
    ada: { username: 'ada', password: process.env.ADA_PASSWORD ?? '' },
  },
} satisfies E2EConfig;
