import { existsSync } from 'node:fs';
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { E2EConfig } from 'e2e';
import base from './e2e.config.ts';

const envFile = new URL('./.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { DEEPSEEK_API_KEY: apiKey, DEEPSEEK_BASE_URL: baseURL, DEEPSEEK_MODEL: model } = process.env;
if (!apiKey || !baseURL || !model) {
    throw new Error('请在 .env 或运行环境中填写 DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL 和 DEEPSEEK_MODEL');
}

export default {
    ...base,
    projectId: 'procurement-admin-agent',
    tests: 'tests-agent/**/*.e2e.ts',
    timeout: 300_000,
    actionTimeout: 90_000,
    agents: { default: { model: createDeepSeek({ baseURL, apiKey })(model) } },
} satisfies E2EConfig;