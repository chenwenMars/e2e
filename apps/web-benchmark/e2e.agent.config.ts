import type { E2EConfig } from 'e2e';
import { github } from '@e2e-dev/github';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import base from './e2e.config.ts';

loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));

const model = process.env.DEEPSEEK_MODEL;
const baseURL = process.env.DEEPSEEK_BASE_URL;
if (!model || !baseURL) {
  throw new Error('Set DEEPSEEK_MODEL and DEEPSEEK_BASE_URL in apps/web-benchmark/.env');
}

const deepseek = createDeepSeek({ baseURL });

/**
 * Agentic suite against the same app and account as the deterministic one.
 * It gates every PR from this repository's branches alongside that suite
 * (`benchmark.yml`), replaying the recordings committed under `.e2e/cache/`
 * and calling the model for a step with none. To re-record by hand:
 *
 *   pnpm --filter @e2e-dev/web-benchmark test:agent
 *
 * DeepSeek credentials, endpoint, and model are configured in the local .env.
 */
export default {
  ...base,
  projectId: 'dev.e2e.web-benchmark-agent',
  tests: 'tests-agent/**/*.e2e.ts',
  // Every agent step includes model round trips, so the deterministic action
  // budget is too tight for a loaded provider. Latency is not a scenario defect.
  timeout: 300_000,
  actionTimeout: 90_000,
  reporters: ['list', github({ key: 'web agent' })],
  agents: {
    default: {
      model: deepseek(model),
      // The ceiling a step may ask for: a per-call `maxSteps` can only lower it,
      // and the scroll-heavy scenarios declare the budget they need per test.
      maxSteps: 60,
      context: [
        'This is the e2e web benchmark: a list of self-contained scenarios, each',
        'served at /e/<slug>. A step plays out inside the scenario page it starts',
        'on; the "Benchmark Examples" link in the header leaves it, so never',
        'follow it unless the step says so.',
      ].join(' '),
    },
  },
} satisfies E2EConfig;
