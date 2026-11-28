import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '@e2e-dev/core';
import { afterEach, expect, it, vi } from 'vitest';
import { mobile } from '../../src/engine-entry.ts';

afterEach(() => vi.unstubAllEnvs());

it.each([
  { command: 'install', options: {} },
  { command: 'reinstall', options: { reinstall: true } },
])('lets the leased daemon resolve an absolute build path for $command', async ({ command, options }) => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_TRANSPORT', 'http');
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', undefined);

  const cwd = mkdtempSync(join(tmpdir(), 'e2e-mobile-install-'));
  const runnerBuild = join(cwd, 'runner.apk');
  const daemonBuild = join(cwd, 'daemon.apk');
  const app = 'com.example.app';
  const deviceId = 'emulator-5554';
  const uploads: Buffer[] = [];
  const installs: { command: string; positionals: string[]; meta: { uploadedArtifactId?: string } }[] = [];

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/upload') {
      uploads.push(body);
      response.end(JSON.stringify({ ok: true, uploadId: 'runner-build' }));
      return;
    }
    if (request.url !== '/rpc') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const { id, params }: { id: string; params: (typeof installs)[number] } = JSON.parse(body.toString());
    const installing = params.command === 'install' || params.command === 'reinstall';
    if (installing) installs.push(params);
    const data = installing
      ? { app, appPath: params.positionals.at(-1), platform: 'android', package: app, identifiers: { package: app } }
      : { device: { id: deviceId, serial: deviceId, platform: 'android', name: 'Scripted device', booted: true } };
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true, data } }));
  });
  const device = {
    name: 'scripted daemon',
    async acquire() {
      const { port } = server.address() as AddressInfo;
      return { id: 'leased-device', deviceId, daemon: { baseUrl: `http://127.0.0.1:${port}` } };
    },
    async release() {},
  };

  const buildContents = 'runner build bytes';
  try {
    writeFileSync(runnerBuild, buildContents);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject).listen(0, '127.0.0.1', resolve);
    });
    await using host = await launch(mobile({ platform: 'android', device }), {
      app: { bundleId: app, appPath: runnerBuild }, cwd, timeout: 5000,
    });
    await using session = await host.newSession();

    await expect(session.device.installApp('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(session.device.installApp('daemon.apk', options)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(installs).toEqual([]);
    expect(uploads).toEqual([]);

    const installed = { app, bundleId: app };
    await expect(session.device.installApp()).resolves.toEqual(installed);
    await expect(session.device.installApp('runner.apk', options)).resolves.toEqual(installed);
    expect(installs.map((request) => [request.command, request.positionals.at(-1), request.meta.uploadedArtifactId])).toEqual([
      ['install', runnerBuild, 'runner-build'],
      [command, runnerBuild, 'runner-build'],
    ]);
    expect(uploads.map(String)).toEqual([buildContents, buildContents]);

    await expect(session.device.installApp(daemonBuild, options)).resolves.toEqual(installed);
    expect(installs[2]).toMatchObject({
      command,
      positionals: command === 'reinstall' ? [app, daemonBuild] : [daemonBuild],
    });
    expect(installs[2]?.meta.uploadedArtifactId).toBeUndefined();
    expect(uploads).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
});
