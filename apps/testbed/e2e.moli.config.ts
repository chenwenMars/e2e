import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { moli } from '@e2e-dev/moli';
import base from './e2e.config.ts';

const endpoint = process.env.MOLI_CDP_URL?.trim() || undefined;

/** The local suite on managed Moli browsers, or an existing CDP server when named. */
export default {
  ...base,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  actionTimeout: 5_000,
  output: '.e2e-moli',
  targets: base.targets.map((target) => ({
    ...target,
    name: 'moli',
    engine: web(endpoint === undefined ? { browser: moli() } : { connect: { cdpEndpoint: () => endpoint } }),
  })),
} satisfies E2EConfig;
