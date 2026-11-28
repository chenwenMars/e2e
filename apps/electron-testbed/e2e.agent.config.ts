import type { E2EConfig } from 'e2e';
import { gateway } from 'ai';
import base from './e2e.config.ts';

/**
 * The agentic suite against the same app. Run by hand, with a model:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/electron-testbed test:agent
 *
 * `E2E_MODEL` overrides the pinned model.
 */
export default {
  ...base,
  projectId: 'dev.e2e.electron-testbed-agent',
  tests: 'tests-agent/**/*.e2e.ts',
  timeout: 300_000,
  agents: {
    default: {
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-6-luna-fast'),
      judgmentTimeout: 90_000,
      context: 'This is an Electron desktop app with a sign-in form, read through Chromium\'s accessibility tree.',
    },
  },
} satisfies E2EConfig;
