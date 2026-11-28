/**
 * The ffmpeg that encodes a recording: `E2E_FFMPEG_PATH`, else the pinned
 * build in the e2e cache, else a system one with VP9, else that pinned build
 * downloaded on the first recording.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { EngineError, InfrastructureError } from '@e2e-dev/core/engine';

/** The pinned `eugeneware/ffmpeg-static` release, and the SHA-256 of each platform's `.gz` asset. */
const BUILD = 'b6.1.1';
const SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  'darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  'linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  'linux-arm64': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
  'win32-x64': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
};

type Env = Readonly<Record<string, string | undefined>>;

/** The cache directory e2e's engines keep downloaded binaries in. */
function cacheDirectory(env: Env): string {
  const configured = env['E2E_BROWSERS_PATH'];
  if (configured !== undefined && configured !== '') return path.resolve(configured);
  if (process.platform === 'win32') return path.join(env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'e2e', 'browsers');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'e2e', 'browsers');
  return path.join(env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'e2e', 'browsers');
}

function cachedFfmpeg(env: Env): string {
  return path.join(cacheDirectory(env), `ffmpeg-${BUILD}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

/** `ffmpeg` on the PATH when it encodes VP9, else null; probed once. */
let systemFfmpeg: string | null | undefined;

function encodesVp9(executable: string): boolean {
  const result = spawnSync(executable, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 && result.stdout.includes('libvpx-vp9');
}

/** One download per process, shared by attempts that start recording together. */
let downloading: Promise<string> | undefined;

/**
 * The ffmpeg to encode with, downloaded into the cache when the machine has
 * none. Throws `UNSUPPORTED_CAPABILITY` on a platform with no pinned build.
 */
export async function ensureFfmpeg(env: Env, signal: AbortSignal): Promise<string> {
  const configured = env['E2E_FFMPEG_PATH'];
  if (configured !== undefined && configured !== '') return configured;
  const cached = cachedFfmpeg(env);
  if (existsSync(cached)) return cached;
  systemFfmpeg ??= encodesVp9('ffmpeg') ? 'ffmpeg' : null;
  if (systemFfmpeg !== null) return systemFfmpeg;
  // Windows on Arm runs the x64 build.
  const platform = process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`;
  const sha256 = SHA256[platform];
  if (sha256 === undefined) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `recording video needs an ffmpeg with libvpx-vp9, and none is pinned for ${platform}: set E2E_FFMPEG_PATH`, { retryable: false });
  }
  downloading ??= download(platform, sha256, cached, signal).finally(() => {
    downloading = undefined;
  });
  return await downloading;
}

async function download(platform: string, sha256: string, target: string, signal: AbortSignal): Promise<string> {
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${BUILD}/ffmpeg-${platform}.gz`;
  const failed = (why: string, cause?: unknown): InfrastructureError =>
    new InfrastructureError('ELECTRON_INSTALL_FAILED', `downloading ffmpeg for video recording from ${url} failed: ${why}; set E2E_FFMPEG_PATH to an ffmpeg with libvpx-vp9`, { cause });
  let archive: Buffer;
  try {
    const response = await fetch(url, { signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    throw failed(cause instanceof Error ? cause.message : String(cause), cause);
  }
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== sha256) throw failed(`its SHA-256 is ${actual}, not the pinned ${sha256}`);
  mkdirSync(path.dirname(target), { recursive: true });
  // Written beside the target and renamed over it, so another worker never runs half a file.
  const staged = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(staged, gunzipSync(archive));
    chmodSync(staged, 0o755);
    renameSync(staged, target);
  } catch (cause) {
    rmSync(staged, { force: true });
    // Another process may have put it there first.
    if (!existsSync(target)) throw failed(cause instanceof Error ? cause.message : String(cause), cause);
  }
  return target;
}
