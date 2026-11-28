/**
 * A recording of the app: the DevTools screencast of whichever window is
 * shown, its JPEG frames encoded to one VP9 webm by ffmpeg. The file outlives
 * a window: switching windows, or relaunching the app, moves the screencast
 * to the window shown next, and the gap holds the last frame.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { EngineError, type VideoFile } from '@e2e-dev/core/engine';
import { answerWithin } from './budget.ts';
import type { PageTarget } from './page.ts';

/** Frames a second of the encoded video. */
const FPS = 25;
const JPEG_QUALITY = 90;
/** How long the last frame holds past the end: a viewer needs a moment on the final screen. */
const FRAME_GRACE_MS = 1_000;
/** How long ffmpeg gets to take the queued frames and write the file before it is killed. */
const CLOSE_TIMEOUT_MS = 10_000;
/** How much of ffmpeg's error output a failed encode reports. */
const STDERR_TAIL = 2_000;
/** How long a window gets to hand over its last screen when the recording stops. */
const LAST_SCREEN_MS = 2_000;

interface Size {
  readonly width: number;
  readonly height: number;
}

/** The window being recorded, and how to stop its screencast. */
interface Source {
  readonly page: PageTarget;
  stop(): Promise<void>;
}

export class Recorder {
  private encoder: FrameEncoder | undefined;
  private startedAt: string | undefined;
  private source: Source | undefined;
  /** Source switches run one at a time, in the order the windows were shown. */
  private switching: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly absolute: string;

  /**
   * `relative` is the file under the attempt's artifacts. `allowed` says
   * whether a window's pixels may be kept: frames of one that may not are
   * dropped, and the video holds the frame before.
   */
  constructor(
    private readonly ffmpeg: string,
    artifactsDir: string,
    private readonly relative: string,
    private readonly allowed: (page: PageTarget) => boolean,
  ) {
    this.absolute = path.join(artifactsDir, relative);
  }

  /** Records `page` from now on, or nothing when the app shows no window. */
  follow(page: PageTarget | undefined): void {
    this.switching = this.switching.then(() => this.switchTo(page)).catch(() => undefined);
  }

  private async switchTo(page: PageTarget | undefined): Promise<void> {
    if (this.stopped || this.source?.page === page) return;
    await this.source?.stop();
    this.source = undefined;
    if (page === undefined || page.isClosed()) return;
    const { session } = page;
    if (this.encoder === undefined) {
      const { cssVisualViewport } = await session.send('Page.getLayoutMetrics');
      // Even sides: the encoder's pixel format halves them.
      const size = { width: Math.max(2, Math.floor(cssVisualViewport.clientWidth / 2) * 2), height: Math.max(2, Math.floor(cssVisualViewport.clientHeight / 2) * 2) };
      mkdirSync(path.dirname(this.absolute), { recursive: true });
      this.startedAt = new Date().toISOString();
      this.encoder = new FrameEncoder(this.ffmpeg, size, this.absolute);
    }
    const encoder = this.encoder;
    const off = session.on('Page.screencastFrame', (frame) => {
      // Acknowledged once the encoder took it, so the window sends no faster than ffmpeg encodes.
      const taken = this.allowed(page) ? encoder.frame(Buffer.from(frame.data, 'base64')) : Promise.resolve();
      void taken.then(() => session.send('Page.screencastFrameAck', { sessionId: frame.sessionId })).catch(() => undefined);
    });
    page.recording = true;
    this.source = {
      page,
      stop: async () => {
        off();
        page.recording = false;
        await session.send('Page.stopScreencast').catch(() => undefined);
      },
    };
    try {
      await session.send('Page.startScreencast', { format: 'jpeg', quality: JPEG_QUALITY, maxWidth: encoder.size.width, maxHeight: encoder.size.height });
    } catch {
      // A window that closed as it was shown: the next one shown is recorded.
      off();
      page.recording = false;
      this.source = undefined;
      return;
    }
    // A window shown again repaints nothing: the video would hold the window before it.
    await this.snap();
  }

  /**
   * Ends the recording and returns its file, or nothing when no window was
   * ever shown.
   */
  async stop(): Promise<readonly VideoFile[]> {
    await this.switching;
    this.stopped = true;
    const { source, encoder, startedAt } = this;
    if (encoder === undefined || startedAt === undefined) return [];
    try {
      await this.snap();
      await source?.stop();
    } finally {
      this.source = undefined;
      await encoder.close().catch((cause: unknown) => {
        if (!existsSync(this.absolute)) {
          throw new EngineError('ENGINE_FAILURE', `the video ${this.relative} could not be finalized: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: false, cause });
        }
      });
    }
    return existsSync(this.absolute) ? [{ path: this.relative, startedAt }] : [];
  }

  /**
   * Adds the shown window as it stands to the video. A screencast sends a
   * frame only when the window repaints, so a still window is captured here:
   * once the app has launched, and when the recording ends.
   */
  async snap(): Promise<void> {
    const { source, encoder } = this;
    if (source === undefined || encoder === undefined || source.page.isClosed() || !this.allowed(source.page)) return;
    const screen = await answerWithin(source.page.session.send('Page.captureScreenshot', { format: 'jpeg', quality: JPEG_QUALITY }), LAST_SCREEN_MS);
    if (screen !== undefined) await encoder.frame(Buffer.from(screen.data, 'base64'));
  }

  /** Ends a recording nobody collects: the file it wrote is removed. */
  async abandon(): Promise<void> {
    await this.switching;
    this.stopped = true;
    await this.source?.stop();
    this.source = undefined;
    await this.encoder?.abort();
  }
}

/**
 * Encodes screencast frames to a constant-rate VP9 webm with ffmpeg. The
 * output is a timeline of `FPS` ticks from the encoder's start: a frame
 * takes the tick it arrives in, a tick a frame already took leaves the newer
 * one for the next, and a tick with no new frame repeats the last. A frame
 * of another size (a second window, a dense display) is scaled down to fit
 * and padded. Writes are serialized through ffmpeg's drain cycle.
 */
class FrameEncoder {
  private readonly process: ChildProcess;
  private last: Buffer | undefined;
  private written = 0;
  private readonly startedAt = performance.now();
  private writing: Promise<void> = Promise.resolve();
  private stderr = '';
  private failure: Error | undefined;
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(
    ffmpeg: string,
    readonly size: Size,
    private readonly output: string,
  ) {
    const { width, height } = size;
    const args = [
      '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-y', '-an',
      '-c:v', 'libvpx-vp9', '-qmin', '0', '-qmax', '50', '-crf', '8', '-deadline', 'realtime', '-cpu-used', '8',
      '-b:v', '1M', '-row-mt', '1',
      '-vf', `scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease,pad=${width}:${height}:0:0:gray,format=yuv420p`,
      output,
    ];
    this.process = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    this.process.on('error', (cause) => {
      this.failure ??= cause;
    });
    this.process.stdin?.on('error', (cause) => {
      this.failure ??= cause;
    });
    this.exited = new Promise((resolve) => {
      this.process.once('error', () => resolve({ code: null, signal: null }));
      this.process.once('close', (code, signal) => resolve({ code, signal }));
    });
  }

  /** Takes the next frame; resolves once the encoder took every frame up to it. */
  frame(jpeg: Buffer): Promise<void> {
    const due = this.due(0);
    this.fill(due);
    if (this.written === due) this.write(jpeg);
    this.last = jpeg;
    return this.writing;
  }

  /**
   * Holds the last frame until now and a moment past it, then closes the
   * input and resolves once ffmpeg wrote the file. A recording that never
   * got a frame writes none.
   */
  async close(): Promise<void> {
    if (this.last === undefined) {
      await this.abort();
      return;
    }
    const timer = setTimeout(() => this.process.kill('SIGKILL'), CLOSE_TIMEOUT_MS);
    this.fill(this.due(FRAME_GRACE_MS));
    await Promise.race([this.writing, this.exited]);
    this.process.stdin?.end();
    const { code, signal } = await this.exited.finally(() => clearTimeout(timer));
    if (this.failure !== undefined) throw new Error(`ffmpeg failed: ${this.failure.message}`);
    if (code !== 0) throw new Error(`ffmpeg ${signal === null ? `exited with ${String(code)}` : `was killed (${signal})`}${this.stderr === '' ? '' : `: ${this.stderr.trim()}`}`);
  }

  /** Kills the encoder and removes what it wrote. */
  async abort(): Promise<void> {
    this.process.kill('SIGKILL');
    await this.exited;
    rmSync(this.output, { force: true });
  }

  /** The tick the timeline is at, `aheadMs` from now. */
  private due(aheadMs: number): number {
    return Math.floor(((performance.now() + aheadMs - this.startedAt) / 1000) * FPS);
  }

  /** Repeats the last frame for every tick before `due` with none. */
  private fill(due: number): void {
    if (this.last === undefined) return;
    while (this.written < due) this.write(this.last);
  }

  private write(jpeg: Buffer): void {
    this.written += 1;
    this.writing = this.writing.then(() => this.push(jpeg));
  }

  /** Hands one frame to ffmpeg, waiting for its input to drain when full. */
  private push(jpeg: Buffer): Promise<void> | undefined {
    const stdin = this.process.stdin;
    if (stdin === null || !stdin.writable || this.failure !== undefined) return undefined;
    if (stdin.write(jpeg)) return undefined;
    return new Promise((resolve) => {
      const done = (): void => {
        stdin.off('drain', done);
        stdin.off('close', done);
        resolve();
      };
      stdin.once('drain', done);
      stdin.once('close', done);
    });
  }
}
