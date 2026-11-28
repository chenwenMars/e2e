/**
 * `revylBrowsers()` against a scripted Revyl API: the options it refuses,
 * the session it starts and the CDP URL it leases, and the session it stops
 * on every path. The CDP attach itself is `@e2e-dev/web`'s, tested there.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import type { ProviderRecordContext } from 'e2e/engine';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { revylBrowsers, type RevylBrowsersOptions } from '../../src/web.ts';

const env = { REVYL_API_KEY: 'revyl-key' };
const options: RevylBrowsersOptions = { app: 'app-1', url: 'https://staging.example.com/' };
const CDP_URL = 'wss://backend.revyl.ai/api/v1/execution/device-proxy/run-1/cdp?ticket=rcdp_x';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

let calls: Call[];
/** Answers by `METHOD path`, the first matching prefix; a function answers each call in turn. */
let routes: Record<string, (call: Call) => Response>;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  routes = {
    'POST /api/v1/apps/app-1/builds/external': () => json({ id: 'build-1' }),
    'POST /api/v1/execution/start_device': (call) => json({ session_id: (call.body as { session_id: string }).session_id, workflow_run_id: 'run-1' }),
    'GET /api/v1/execution/device-sessions/': () => json({ status: 'running', workflow_run_id: 'run-1', viewer_kind: 'whep', started_at: '2026-11-21T23:44:44.536193+00:00' }),
    'POST /api/v1/execution/device-proxy/run-1/cdp': () => json({ url: CDP_URL, expires_at: '2026-11-21T00:01:00Z' }),
    'POST /api/v1/execution/device/sessions/': () => json({ ok: true }),
  };
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const call: Call = { method: init.method ?? 'GET', url: input, body: init.body === undefined ? undefined : JSON.parse(init.body as string), headers: init.headers as Record<string, string> };
    calls.push(call);
    const route = Object.keys(routes).find((key) => `${call.method} ${url.pathname}`.startsWith(key));
    if (route === undefined) throw new Error(`unscripted ${call.method} ${url.pathname}`);
    return routes[route]!(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<BrowserRequest> = {}): BrowserRequest {
  return { runId: 'run', targetName: 'web', slot: 0, slots: 1, attemptId: 'attempt-1', env, signal: new AbortController().signal, log: () => undefined, ...overrides };
}

const recordContext: ProviderRecordContext = { runId: 'run', targetName: 'web', attemptId: 'attempt-1', env, signal: new AbortController().signal };
const context: BrowserReleaseContext = { runId: 'run', targetName: 'web', env, signal: new AbortController().signal, log: () => undefined };
const failure = (pending: Promise<unknown>): Promise<Error> => pending.then(() => new Error('resolved'), (error: unknown) => error as Error);
const paths = () => calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
const stops = () => calls.filter((call) => call.url.endsWith('/stop'));

describe('revylBrowsers()', () => {
  it('leases per attempt, since a Revyl session has one browser context', () => {
    const provider = revylBrowsers(options);

    expect(provider.name).toBe('revyl');
    expect(provider.scope).toBe('attempt');
    expect(provider.downloads).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['a missing app', { url: 'https://staging.example.com' }],
    ['a blank app', { app: ' ', url: 'https://staging.example.com' }],
    ['a missing url', { app: 'app-1' }],
    ['a url that is not http(s)', { app: 'app-1', url: 'file:///tmp/index.html' }],
    ['a url with credentials', { app: 'app-1', url: 'https://user:pass@staging.example.com' }],
    ['a null viewport', { ...options, viewport: null }],
    ['a fractional viewport', { ...options, viewport: { width: 1280.5, height: 800 } }],
    ['a viewport out of range', { ...options, viewport: { width: 200, height: 800 } }],
    ['an idle timeout under a minute', { ...options, idleTimeoutSeconds: 30 }],
    ['an unknown option', { ...options, headless: true }],
  ])('refuses %s with INVALID_CONFIG', (_, given) => {
    expect(() => revylBrowsers(given as RevylBrowsersOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it("starts a session on the url's build, waits until it runs, and leases its single-use CDP URL", async () => {
    let polls = 0;
    routes['GET /api/v1/execution/device-sessions/'] = () => json(++polls < 2 ? { status: 'starting' } : { status: 'running', workflow_run_id: 'run-1', viewer_kind: 'whep' });
    const lines: string[] = [];
    const lease = await revylBrowsers({ ...options, viewport: { width: 1440, height: 900 }, idleTimeoutSeconds: 300 }).acquire(request({ log: (line) => lines.push(line) }));

    expect(lease.cdpEndpoint).toBe(CDP_URL);
    expect(lease.reconnectEndpoint).toBeUndefined();
    expect(calls[0]!.body).toEqual({ url: 'https://staging.example.com/' });
    expect(calls[1]!.body).toEqual({
      platform: 'web',
      app_id: 'app-1',
      build_id: 'build-1',
      session_id: lease.id,
      idle_timeout_seconds: 300,
      web: { viewport: { width: 1440, height: 900 } },
    });
    expect(paths().at(-1)).toBe('POST /api/v1/execution/device-proxy/run-1/cdp');
    expect(calls.every((call) => call.url.startsWith('https://backend.revyl.ai/') && call.headers.Authorization === 'Bearer revyl-key' && /^e2e-revyl\/\d+\.\d+\.\d+/.test(call.headers['User-Agent']!))).toBe(true);
    expect(lines).toEqual([`session ${lease.id}, watch at https://app.revyl.ai/sessions/${lease.id}`]);
    expect(stops()).toEqual([]);
  });

  it("leaves the viewport to Revyl when it is not set, and stops idle sessions after 600 s", async () => {
    await revylBrowsers(options).acquire(request());

    expect(calls[1]!.body).not.toHaveProperty('web');
    expect(calls[1]!.body).toMatchObject({ idle_timeout_seconds: 600 });
  });

  it('calls REVYL_API_URL when set, and logs no viewer link for it', async () => {
    const lines: string[] = [];
    const lease = await revylBrowsers(options).acquire(request({ env: { ...env, REVYL_API_URL: 'https://backend-staging.revyl.ai/' }, log: (line) => lines.push(line) }));

    expect(calls.every((call) => call.url.startsWith('https://backend-staging.revyl.ai/api/'))).toBe(true);
    expect(lines).toEqual([`session ${lease.id}`]);
  });

  it('fails without REVYL_API_KEY before calling Revyl', async () => {
    await expect(revylBrowsers(options).acquire(request({ env: {} }))).rejects.toThrow('REVYL_API_KEY is not set');
    expect(calls).toEqual([]);
  });

  it('stops a session that ended before it was ready, and keeps the reason', async () => {
    routes['GET /api/v1/execution/device-sessions/'] = () => json({ status: 'failed', error_message: "Couldn't open staging.example.com: the site returned 404." });

    const failed = await failure(revylBrowsers(options).acquire(request()));

    expect(failed.message).toMatch(/did not start \(stopped\)/);
    expect((failed.cause as Error).message).toContain('the site returned 404');
    expect(stops()).toHaveLength(1);
    expect(stops()[0]!.url).toContain((calls[1]!.body as { session_id: string }).session_id);
  });

  it('stops the session when Revyl refuses to mint a CDP URL', async () => {
    routes['POST /api/v1/execution/device-proxy/run-1/cdp'] = () => json({ detail: 'CDP is not available on this worker', code: 'not_available_on_platform' }, 400);

    const failed = await failure(revylBrowsers(options).acquire(request()));

    expect((failed.cause as Error).message).toContain('answered 400: CDP is not available on this worker');
    expect(stops()).toHaveLength(1);
  });

  it('stops a session that became ready after the attempt was cancelled', async () => {
    const abort = new AbortController();
    const minted = routes['POST /api/v1/execution/device-proxy/run-1/cdp']!;
    routes['POST /api/v1/execution/device-proxy/run-1/cdp'] = (call) => {
      abort.abort(new Error('attempt cancelled'));
      return minted(call);
    };

    await expect(revylBrowsers(options).acquire(request({ signal: abort.signal }))).rejects.toThrow(/did not start \(stopped\)/);
    expect(stops()).toHaveLength(1);
  });

  it('says so when stopping a failed start fails too', async () => {
    routes['POST /api/v1/execution/device-proxy/run-1/cdp'] = () => json({ detail: 'nope' }, 400);
    routes['POST /api/v1/execution/device/sessions/'] = () => json({ detail: 'down' }, 500);

    await expect(revylBrowsers(options).acquire(request())).rejects.toThrow(/stopping it failed, so Revyl ends it after 600 s idle/);
  });

  it('mints the CDP URL again after a gateway error, before the session is given up', async () => {
    let answers = 0;
    const minted = routes['POST /api/v1/execution/device-proxy/run-1/cdp']!;
    routes['POST /api/v1/execution/device-proxy/run-1/cdp'] = (call) => (++answers === 1 ? new Response('<html>bad gateway</html>', { status: 502 }) : minted(call));

    const lease = await revylBrowsers(options).acquire(request());

    expect(lease.cdpEndpoint).toBe(CDP_URL);
    expect(answers).toBe(2);
    expect(stops()).toEqual([]);
  });

  it('stops the session on release, and counts one Revyl already ended as stopped', async () => {
    const provider = revylBrowsers(options);

    await provider.release({ id: 'session-1', cdpEndpoint: CDP_URL }, context);
    routes['POST /api/v1/execution/device/sessions/'] = () => json({ detail: 'Session already ended' }, 409);
    await provider.release({ id: 'session-2', cdpEndpoint: CDP_URL }, context);

    expect(paths()).toEqual(['POST /api/v1/execution/device/sessions/session-1/stop', 'POST /api/v1/execution/device/sessions/session-2/stop']);
  });

  it("records with the session's own recording, which it saves once the session stops", async () => {
    let timelines = 0;
    routes['GET /api/v1/reports-v3/reports/by-session/session-1/video-timeline'] = () =>
      json(++timelines < 2 ? { recording_status: 'pending', video_url: null } : { recording_status: 'ready', video_url: 'https://videos.example.com/session-1.mp4?X-Amz-Signature=s' });
    routes['GET /session-1.mp4'] = () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
    const dir = mkdtempSync(path.join(tmpdir(), 'revyl-recording-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const recording = await revylBrowsers(options).record!({ id: 'session-1', cdpEndpoint: CDP_URL }, recordContext);
    expect(recording.startedAt).toBe('2026-11-21T23:44:44.536193+00:00');
    expect(stops()).toEqual([]);
    const result = await recording.stop({ dir, signal: new AbortController().signal });

    expect(result).toEqual({ file: 'recording.mp4' });
    expect([...readFileSync(path.join(dir, 'recording.mp4'))]).toEqual([0, 0, 0, 24, 102, 116, 121, 112]);
    const order = paths();
    expect(order.indexOf('POST /api/v1/execution/device/sessions/session-1/stop')).toBeLessThan(order.indexOf('GET /api/v1/reports-v3/reports/by-session/session-1/video-timeline'));
    expect(timelines).toBe(2);
    expect(calls.find((call) => call.url.startsWith('https://videos.example.com/'))!.headers).toBeUndefined();
  });

  it('fails a recording Revyl did not keep', async () => {
    routes['GET /api/v1/reports-v3/reports/by-session/session-1/video-timeline'] = () => json({ recording_status: 'unavailable', video_url: null });
    const recording = await revylBrowsers(options).record!({ id: 'session-1', cdpEndpoint: CDP_URL }, recordContext);

    await expect(recording.stop({ dir: tmpdir(), signal: new AbortController().signal })).rejects.toThrow('Revyl kept no recording of session session-1 (unavailable)');
  });

  it('stops again after a gateway error, since a stop is idempotent', async () => {
    let answers = 0;
    routes['POST /api/v1/execution/device/sessions/'] = () => (++answers === 1 ? new Response('<html>bad gateway</html>', { status: 502 }) : json({ ok: true }));

    await revylBrowsers(options).release({ id: 'session-1', cdpEndpoint: CDP_URL }, context);

    expect(stops()).toHaveLength(2);
  });
});
