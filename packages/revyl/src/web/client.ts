/**
 * Revyl's HTTP API for hosted web sessions: registering the start URL as a
 * build, starting and stopping a session, and minting the single-use CDP URL
 * a client attaches to the session's browser with. Every call carries the
 * run's API key and is bounded by its caller's signal.
 */

import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { RevylCredentials } from '../credentials.ts';

export const DEFAULT_API_URL = 'https://backend.revyl.ai';
const CONTROL_TIMEOUT_MS = 60_000;
const READ_ATTEMPTS = 3;
const TERMINAL_STATUSES = new Set(['failed', 'completed', 'cancelled', 'timeout', 'stopping']);
// Revyl's edge refuses requests without a client user agent.
const USER_AGENT = `e2e-revyl/${(createRequire(import.meta.url)('../../package.json') as { version: string }).version}`;

export interface WebViewport {
  readonly width: number;
  readonly height: number;
}

export interface SessionRequest {
  readonly sessionId: string;
  readonly appId: string;
  readonly buildId: string;
  readonly viewport: WebViewport | undefined;
  readonly idleTimeoutSeconds: number;
}

/** One HTTP failure from Revyl, with the path's ids masked. */
class RevylHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Revyl ${path} answered ${status}: ${detail}`);
    this.name = 'RevylHttpError';
  }
}

export class RevylWebClient {
  readonly #apiUrl: string;
  readonly #apiKey: string;

  constructor(credentials: RevylCredentials) {
    this.#apiUrl = (credentials.apiUrl ?? DEFAULT_API_URL).replace(/[/]+$/, '');
    this.#apiKey = credentials.apiKey;
  }

  /** Registers `url` as a build of the Revyl web app; Revyl answers the same build for a URL it already holds. */
  async registerUrlBuild(appId: string, url: string, signal: AbortSignal): Promise<string> {
    const build = fields(await this.#read(signal, () => this.#json('POST', `/api/v1/apps/${encodeURIComponent(appId)}/builds/external`, { url }, signal)));
    if (typeof build.id !== 'string') throw new Error('Revyl did not return a build id for the start URL');
    return build.id;
  }

  /**
   * Starts the session `request.sessionId` names and waits until its browser
   * runs, resolving to its workflow run id. The caller picks the id, so it can
   * stop the session after a start that failed at any point.
   */
  async startSession(request: SessionRequest, signal: AbortSignal): Promise<string> {
    const body = {
      platform: 'web',
      app_id: request.appId,
      build_id: request.buildId,
      session_id: request.sessionId,
      idle_timeout_seconds: request.idleTimeoutSeconds,
      ...(request.viewport === undefined ? {} : { web: { viewport: request.viewport } }),
    };
    const started = fields(await this.#json('POST', '/api/v1/execution/start_device', body, signal));
    if (typeof started.workflow_run_id !== 'string' || started.session_id !== request.sessionId) {
      throw new Error(`Revyl refused the web session: ${typeof started.error === 'string' ? started.error : 'no session in the response'}`);
    }
    return this.#waitUntilRunning(request.sessionId, signal);
  }

  /** Mints a single-use `wss://` URL to the session's browser, valid for about a minute. */
  async cdpUrl(workflowRunId: string, signal: AbortSignal): Promise<string> {
    const minted = fields(await this.#read(signal, () => this.#json('POST', `/api/v1/execution/device-proxy/${encodeURIComponent(workflowRunId)}/cdp`, undefined, signal)));
    if (typeof minted.url !== 'string' || minted.url === '') throw new Error('Revyl did not return a CDP URL for the session');
    return minted.url;
  }

  /** When the session's browser started running, as Revyl reports it: the start of its recording, to within a tenth of a second. */
  async startedAt(sessionId: string, signal: AbortSignal): Promise<string> {
    const detail = fields(await this.#read(signal, () => this.#json('GET', `/api/v1/execution/device-sessions/${encodeURIComponent(sessionId)}`, undefined, signal)));
    if (typeof detail.started_at !== 'string' || Number.isNaN(Date.parse(detail.started_at))) throw new Error(`Revyl reports no start time for session ${sessionId}`);
    return detail.started_at;
  }

  /**
   * Writes an ended session's recording to `file`. Revyl publishes it once the
   * session stops, so this waits while it is pending; a session Revyl kept no
   * recording of fails.
   */
  async downloadRecording(sessionId: string, file: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      const timeline = fields(
        await this.#read(signal, () => this.#json('GET', `/api/v1/reports-v3/reports/by-session/${encodeURIComponent(sessionId)}/video-timeline`, undefined, signal)),
      );
      if (timeline.recording_status === 'ready' && typeof timeline.video_url === 'string') {
        // A presigned storage URL, which refuses the API key.
        const response = await fetch(timeline.video_url, { signal });
        if (!response.ok || response.body === null) throw new Error(`downloading session ${sessionId}'s recording answered ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(file), { signal });
        return;
      }
      if (timeline.recording_status !== 'pending') throw new Error(`Revyl kept no recording of session ${sessionId} (${String(timeline.recording_status)})`);
      await sleep(1_000, signal);
    }
  }

  /**
   * Stops a session, again after a gateway error or a dropped connection
   * since a stop is idempotent. A session Revyl never made (404) or already
   * ended (409) counts as stopped.
   */
  async stopSession(sessionId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.#read(signal, () => this.#json('POST', `/api/v1/execution/device/sessions/${encodeURIComponent(sessionId)}/stop`, undefined, signal));
    } catch (error) {
      if (!(error instanceof RevylHttpError && (error.status === 404 || error.status === 409))) throw error;
    }
  }

  async #waitUntilRunning(sessionId: string, signal: AbortSignal): Promise<string> {
    const started = Date.now();
    for (;;) {
      const detail = fields(await this.#read(signal, () => this.#json('GET', `/api/v1/execution/device-sessions/${encodeURIComponent(sessionId)}`, undefined, signal)));
      if (typeof detail.status === 'string' && TERMINAL_STATUSES.has(detail.status)) {
        const reason = typeof detail.error_message === 'string' ? detail.error_message : detail.status;
        throw new Error(`Revyl web session ${sessionId} ended before it was ready: ${reason}`);
      }
      if (detail.status === 'running' && typeof detail.workflow_run_id === 'string' && detail.viewer_kind === 'whep') {
        return detail.workflow_run_id;
      }
      await sleep(Date.now() - started < 60_000 ? 500 : 2_000, signal);
    }
  }

  /** Runs a call again after a rate limit, a gateway error, or a dropped connection, none of which reached the session. */
  async #read<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        const transient = error instanceof RevylHttpError ? error.status === 429 || (error.status >= 502 && error.status <= 504) : error instanceof TypeError;
        if (!transient || signal.aborted || attempt >= READ_ATTEMPTS) throw error;
      }
      await sleep(500 * attempt, signal);
    }
  }

  async #json(method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'User-Agent': USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]),
    });
    const text = await response.text();
    if (!response.ok) throw new RevylHttpError(response.status, path.replace(/[0-9a-f-]{36}/g, ':id'), errorDetail(text));
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  }
}

/** A JSON object's fields, or none for any other answer. */
function fields(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The `detail` of a FastAPI error, or the start of the body. */
function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'detail' in parsed) {
      const detail = (parsed as { detail: unknown }).detail;
      return typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300);
    }
  } catch {
    // An edge error page, not JSON.
  }
  if (/^\s*</.test(body)) return "an HTML error page from Revyl's edge";
  return body.slice(0, 300).trim();
}

/** Waits `ms`, ending early with the signal's own reason when it aborts. */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal }).catch((error: unknown) => {
    throw signal.aborted ? signal.reason : error;
  });
}
