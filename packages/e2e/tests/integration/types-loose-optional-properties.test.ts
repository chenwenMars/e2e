/**
 * A config keeps its inferred type in a project without
 * `exactOptionalPropertyTypes`, the compiler default and what `e2e init`
 * leaves a project with. There TypeScript types `ci ? { token } : {}` as
 * `{ token: string } | { token?: undefined }`, so `secrets`, `credentials`,
 * `services`, `agents`, an agent's `tools` and `providerOptions`, and a
 * target's `app.permissions` accept an `undefined` value. Otherwise
 * `defineConfig` falls back to `E2EConfig` and `test.extend` rejects
 * `typeof config`. `app.command.env` is the one record left out of this. The
 * repository's own tsconfig turns the option on, so
 * `tests/types/sdk-types.ts` can't see this: the probe is compiled as a
 * separate project.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const TSC = path.join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const PROBE = `import { defineConfig, defineService, test, type E2EConfig } from 'e2e';
import { defineTool } from 'e2e/agent';
import { openHost } from 'e2e/runner';
import { web } from '@e2e-dev/web';

declare const ci: boolean;
declare const lookup: ReturnType<typeof defineTool>;

const email = defineService({
  async *start() {
    yield { url: 'http://localhost:4000' };
  },
});

const config = defineConfig({
  secrets: ci ? { token: 'secret-token' } : {},
  credentials: ci ? { admin: { username: 'admin', password: 'password1' } } : {},
  services: ci ? { email } : {},
  agents: { default: { tools: ci ? { lookup } : {}, providerOptions: ci ? { openai: { reasoningEffort: 'low' } } : {} } },
  targets: [
    {
      engine: web(),
      app: {
        url: 'http://localhost:3000',
        permissions: ci ? { geolocation: 'grant' } : {},
        command: { executable: 'node', args: ['server.mjs'], env: ({ services }) => ({ EMAIL_URL: services.email?.url ?? '' }) },
      },
    },
  ],
});

config satisfies E2EConfig;
void openHost({ config });

const extended = test.extend<{}, {}, typeof config>();
extended('types the fixtures', async ({ browser, services }) => {
  const url: string | undefined = services.email?.url;
  void url;
  void browser;
});

const agentsConfig = defineConfig({
  agents: ci ? { buyer: { system: 'buy' } } : {},
  targets: [{ engine: web() }],
});
void openHost({ config: agentsConfig });
test.extend<{}, {}, typeof agentsConfig>()('types the fixtures', async ({ browser }) => void browser);

defineConfig({
  // @ts-expect-error a secret is a string or a provider
  secrets: ci ? { token: 1 } : {},
  targets: [{ engine: web() }],
});

defineConfig({
  // @ts-expect-error a service comes from defineService
  services: { email, db: 42 },
  targets: [{ engine: web() }],
});

defineConfig({
  // @ts-expect-error a permission state is grant, deny, or reset
  targets: [{ engine: web(), app: { url: 'http://localhost:3000', permissions: ci ? { geolocation: 'granted' } : {} } }],
});
`;

/** A strict NodeNext project with the compiler's default `exactOptionalPropertyTypes: false`. */
const TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023', 'DOM'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  },
  files: ['probe.ts'],
};

describe('a config in a project without exactOptionalPropertyTypes', () => {
  let dir: string;
  let diagnostics: string[];

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'e2e-types-loose-optional-')));
    mkdirSync(path.join(dir, 'node_modules', '@types'), { recursive: true });
    mkdirSync(path.join(dir, 'node_modules', '@e2e-dev'), { recursive: true });
    symlinkSync(PACKAGE_ROOT, path.join(dir, 'node_modules', 'e2e'), 'junction');
    symlinkSync(realpathSync(path.join(PACKAGE_ROOT, 'node_modules', '@e2e-dev', 'web')), path.join(dir, 'node_modules', '@e2e-dev', 'web'), 'junction');
    symlinkSync(path.join(PACKAGE_ROOT, 'node_modules', '@types', 'node'), path.join(dir, 'node_modules', '@types', 'node'), 'junction');
    writeFileSync(path.join(dir, 'probe.ts'), PROBE);
    writeFileSync(path.join(dir, 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);

    const output = await execFileAsync(process.execPath, [TSC, '--project', dir], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })
      .then(
        (result) => `${result.stdout}${result.stderr}`,
        (error: Error & { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}` || error.message,
      );

    diagnostics = output.split('\n').filter((line) => line.trim() !== '');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps its inferred type when a record in it is written as ci ? { ... } : {}', () => {
    expect(diagnostics).toEqual([]);
  });
});
