import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../.github/scripts/agent-device.cjs', import.meta.url));
const version = '0.21.38-nightly.20261113.167';

/** Creates an isolated installed dependency graph without registry access. */
function project(t: TestContext, mobile = false, installed?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'nightly-driver-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dependencies = mobile ? { '@e2e-dev/mobile': '1.0.0' } : {};
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', dependencies }));
  if (mobile) {
    const dir = join(cwd, 'node_modules/@e2e-dev/mobile');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@e2e-dev/mobile', version: '1.0.0', dependencies: installed ? { 'agent-device': installed } : {} }));
  }
  if (installed) {
    const dir = join(cwd, 'node_modules/agent-device');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'agent-device', version: installed }));
  }
  return cwd;
}

/** Runs the same verifier invoked by the example-packages composite action. */
function verify(cwd: string) {
  return spawnSync(process.execPath, [script, 'verify', 'npm'], {
    cwd, encoding: 'utf8', env: { ...process.env, AGENT_DEVICE_VERSION: version, GITHUB_STEP_SUMMARY: '' },
  });
}

test('web-only npm examples verify zero driver entries', (t) => {
  const result = verify(project(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified 0 dependency graph entries/);
});

test('mobile npm examples require an installed driver', (t) => {
  const result = verify(project(t, true));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No installed agent-device found/);
});

test('mobile npm examples verify the transitive driver version', (t) => {
  const result = verify(project(t, true, version));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified 1 dependency graph entries/);
});

test('mobile npm examples reject a different driver version', (t) => {
  const result = verify(project(t, true, '0.21.37'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /resolved to 0.21.37, expected/);
});

test('invalid installed npm graphs still fail verification', (t) => {
  const cwd = project(t);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'example', dependencies: { missing: '1.0.0' } }));
  assert.notEqual(verify(cwd).status, 0);
});

test('the nightly summary lists failed, cancelled and timed-out matrix jobs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/nightly-agent-device.yml', import.meta.url), 'utf8');
  const filter = workflow.match(/--jq '([^']+)'/)?.[1];
  assert.ok(filter, 'workflow must query matrix job results');
  const jobs = ['success', 'failure', 'cancelled', 'timed_out'].map((conclusion) => ({ conclusion, name: conclusion, html_url: `https://example.com/${conclusion}` }));
  const result = spawnSync('jq', ['-r', filter], { input: JSON.stringify({ jobs }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '- [failure](https://example.com/failure): failure\n- [cancelled](https://example.com/cancelled): cancelled\n- [timed_out](https://example.com/timed_out): timed_out\n');
});
