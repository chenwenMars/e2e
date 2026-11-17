import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

const appUrl = process.env.APP_URL;
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default {
  agents: { default: { model: gateway('openai/gpt-6-luna-fast') } },
  targets: [
    {
      engine: web(bypassSecret ? { headers: { 'x-vercel-protection-bypass': bypassSecret } } : {}),
      app: {
        identity: 'my-app',
        environment: process.env.DEPLOYMENT_ENVIRONMENT === 'production' ? 'production' : 'test',
        ...(appUrl
          ? { url: appUrl }
          : {
              url: 'http://localhost:3000',
              command: { executable: 'npm', args: ['run', 'dev'], reuseExisting: true },
            }),
      },
    },
  ],
} satisfies E2EConfig;
