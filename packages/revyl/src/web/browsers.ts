/**
 * Revyl's hosted Chrome as a `BrowserProvider` for the web engine: each test
 * attempt starts a Revyl web session and attaches to its browser over CDP.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BrowserLease, BrowserProvider, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { ConfigurationError, rejectUnknownKeys, type ProviderRecordContext, type ProviderRecording } from 'e2e/engine';
import { revylCredentials } from '../credentials.ts';
import { DEFAULT_API_URL, RevylWebClient, type WebViewport } from './client.ts';

const APP_URL = 'https://app.revyl.ai';
const RECORDING_FILE = 'recording.mp4';

/** Every option `revylBrowsers()` takes, kept equal to `RevylBrowsersOptions` by the compiler. */
const OPTION_KEYS: readonly string[] = Object.keys({
  app: true,
  url: true,
  viewport: true,
  idleTimeoutSeconds: true,
} satisfies Record<keyof RevylBrowsersOptions, true>);

export interface RevylBrowsersOptions {
  /** Id of the Revyl web app the sessions run under. */
  readonly app: string;
  /**
   * `http(s)` URL each session opens on, registered as a build of `app`.
   * Revyl checks it loads before the session is ready, and the test then
   * goes to the target's `app.url` as on any browser.
   */
  readonly url: string;
  /** CSS viewport each session opens with, Revyl's default when absent. The browser keeps it for the session. */
  readonly viewport?: WebViewport | undefined;
  /** Seconds without activity before Revyl ends a session the run left open; 600 when absent. */
  readonly idleTimeoutSeconds?: number | undefined;
}

/**
 * Revyl browsers for `web({ browser: revylBrowsers({ app, url }) })`: a fresh
 * Revyl web session per test attempt, started when the attempt starts and
 * stopped when it ends. The scope is always `attempt`: a Revyl session has
 * one browser context and refuses `Target.createBrowserContext`, which a
 * shared per-worker browser needs to keep tests apart. Each lease's
 * `cdpEndpoint` is a single-use URL that expires about a minute after the
 * session is ready, so a dropped connection is not reattached and fails the
 * attempt. An attempt that records video gets the session's own recording.
 * `REVYL_API_KEY` comes from the run's environment, and
 * `REVYL_API_URL` when set.
 */
export function revylBrowsers(options: RevylBrowsersOptions): BrowserProvider {
  rejectUnknownKeys('revylBrowsers()', options, OPTION_KEYS);
  if (typeof options.app !== 'string' || options.app.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'revylBrowsers: `app` is required, as the id of a Revyl web app');
  }
  if (!isHttpUrl(options.url)) {
    throw new ConfigurationError('INVALID_CONFIG', 'revylBrowsers: `url` must be an http(s) URL, without credentials, that Revyl can open');
  }
  const { viewport } = options;
  if (
    viewport !== undefined &&
    !(typeof viewport === 'object' && viewport !== null && Number.isInteger(viewport.width) && Number.isInteger(viewport.height) && viewport.width >= 320 && viewport.width <= 3840 && viewport.height >= 240 && viewport.height <= 2160)
  ) {
    throw new ConfigurationError('INVALID_CONFIG', 'revylBrowsers: `viewport` must be whole CSS pixels, width 320 to 3840 and height 240 to 2160');
  }
  const idleTimeoutSeconds = options.idleTimeoutSeconds ?? 600;
  if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 60) {
    throw new ConfigurationError('INVALID_CONFIG', 'revylBrowsers: `idleTimeoutSeconds` must be a whole number of seconds, at least 60');
  }
  const app = options.app.trim();

  return {
    name: 'revyl',
    scope: 'attempt',
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const credentials = revylCredentials(request.env);
      const client = new RevylWebClient(credentials);
      const buildId = await client.registerUrlBuild(app, options.url, request.signal);
      const sessionId = randomUUID();
      let cdpEndpoint: string;
      try {
        const workflowRunId = await client.startSession({ sessionId, appId: app, buildId, viewport, idleTimeoutSeconds }, request.signal);
        cdpEndpoint = await client.cdpUrl(workflowRunId, request.signal);
        request.signal.throwIfAborted();
      } catch (cause) {
        // The session id was ours from the start, so a start that failed at any point leaves nothing running.
        const outcome = await client.stopSession(sessionId, AbortSignal.timeout(10_000)).then(
          () => 'stopped',
          (stop: unknown) => `stopping it failed, so Revyl ends it after ${idleTimeoutSeconds} s idle: ${stop instanceof Error ? stop.message : String(stop)}`,
        );
        throw new Error(`Revyl web session ${sessionId} did not start (${outcome})`, { cause });
      }
      // The viewer needs a Revyl sign-in, so it is safe in a public CI log; another backend's viewer is unknown.
      request.log((credentials.apiUrl ?? DEFAULT_API_URL) === DEFAULT_API_URL ? `session ${sessionId}, watch at ${APP_URL}/sessions/${sessionId}` : `session ${sessionId}`);
      return { id: sessionId, cdpEndpoint };
    },
    async release(lease: BrowserLease, context: BrowserReleaseContext): Promise<void> {
      await new RevylWebClient(revylCredentials(context.env)).stopSession(lease.id, context.signal);
    },
    /**
     * Revyl records every web session from its start. Stopping the recording
     * stops the session, since Revyl publishes the recording only then, and
     * saves it as the attempt's `recording.mp4`.
     */
    async record(lease: BrowserLease, context: ProviderRecordContext): Promise<ProviderRecording> {
      const client = new RevylWebClient(revylCredentials(context.env));
      return {
        startedAt: await client.startedAt(lease.id, context.signal),
        async stop({ dir, signal }) {
          await client.stopSession(lease.id, signal);
          await client.downloadRecording(lease.id, path.join(dir, RECORDING_FILE), signal);
          return { file: RECORDING_FILE };
        },
      };
    },
  };
}

/** An `http(s)` URL without credentials in it. */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
}
