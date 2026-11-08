import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));

const model = process.env.DEEPSEEK_MODEL;
const baseURL = process.env.DEEPSEEK_BASE_URL;
if (!model || !baseURL) {
  throw new Error('Set DEEPSEEK_MODEL and DEEPSEEK_BASE_URL in examples/with-vite/.env');
}

const deepseek = createDeepSeek({ baseURL });

export default {
  // The provider reads DEEPSEEK_API_KEY when an agent step calls the model.
  agents: {
    default: {
      model: deepseek(model),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  targets: [
    {
      engine: web(),
      app: {
        url: 'http://localhost:5173',
        // The runner starts the Vite dev server and waits for the URL to answer.
        // Outside CI, a server you already started on that port is reused.
        command: { executable: 'npm', args: ['run', 'dev'], reuseExisting: true },
      },
    },
  ],
} satisfies E2EConfig;
