/** Per-run encrypted session store. */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedTarget } from '../config/resolve.ts';
import { ENGINE_SPI_VERSION } from '../engine/contract.ts';
import type { EngineSpiVersion, EngineState } from '../engine/surface.ts';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { ConfigurationError, E2EError } from '../internal/errors.ts';
import { canonicalDigest, canonicalJson, timestamp } from '../internal/ids.ts';
import { obj } from '../internal/objects.ts';
import type { SavedSecrets } from './secrecy.ts';

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionIdentity {
  readonly targetId: string;
  readonly engineName: string;
  readonly engineVersion: string;
  readonly spiVersion: EngineSpiVersion;
  readonly platform: string;
  readonly appIdentity: string;
}

/**
 * The identity session and replay cache entries key on for one target.
 * It comes from the engine's name and version and the target's resolved
 * app, so an engine swap never restores another engine's state. The app's
 * declared identity (else its URL, bundle id, or build path) keys entries,
 * so an ephemeral per-deploy origin (a PR preview) can share them with the
 * app it is a deployment of. The environment always joins the digest: an
 * identity must never bleed entries across environments.
 */
export function targetIdentity(target: ResolvedTarget): SessionIdentity {
  return {
    targetId: target.name,
    engineName: target.engine?.name ?? 'none',
    engineVersion: target.engine?.version ?? 'unversioned',
    spiVersion: target.engine?.spiVersion ?? ENGINE_SPI_VERSION,
    platform: target.platform,
    appIdentity: canonicalDigest(obj({ identity: target.app.identity, environment: target.app.environment })),
  };
}

/** A sealed document's `state`: the engine state's format, then its AES-256-GCM ciphertext, IV, and tag. */
export interface SealedState {
  format: string;
  version: number;
  algorithm: 'A256GCM';
  iv: string;
  tag: string;
  ciphertext: string;
}

interface SessionEnvelope {
  schemaVersion: 'session-1';
  runId: string;
  name: string;
  targetId: string;
  engine: { name: string; version: string; spiVersion: number };
  platform: string;
  appIdentity: string;
  createdAt: string;
  expiresAt: string;
  /** Authenticated, never encrypted: which secrets the payload carries values for. */
  secrecy?: { names: string[] };
  state: SealedState;
}

/** What one saved session holds once decrypted. */
export interface SavedSession {
  readonly state: EngineState;
  readonly secrets: SavedSecrets;
}

/** The encrypted payload: the engine's state data beside the secret values the envelope names. */
interface SessionPayload {
  data: unknown;
  secrets: [string, string][];
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals a state into a `session-1` or `session-state-1` document: encrypts
 * the state's data and the secret values under `key` (AES-256-GCM, a fresh
 * random IV) and authenticates the rest of the document, `envelope` plus the
 * secret names and the clear part of `state`, as its canonical JSON. The
 * returned document keeps `envelope`'s keys first, in order, so its JSON
 * text is the shape each schema pins.
 */
export function sealSessionPayload<Envelope extends Record<string, unknown>>(
  envelope: Envelope,
  state: Pick<EngineState, 'format' | 'version' | 'data'>,
  secrets: SavedSecrets,
  key: Buffer,
): Envelope & { secrecy: { names: string[] }; state: SealedState } {
  const iv = randomBytes(IV_BYTES);
  const unsealed = {
    ...envelope,
    secrecy: { names: [...new Set(secrets.map(([secretName]) => secretName))] },
    state: {
      format: state.format,
      version: state.version,
      algorithm: 'A256GCM' as const,
      iv: iv.toString('base64'),
    },
  };
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(canonicalJson(unsealed), 'utf8'));
  const payload: SessionPayload = { data: state.data, secrets: secrets.map(([secretName, value]) => [secretName, value]) };
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return {
    ...unsealed,
    state: {
      ...unsealed.state,
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    },
  };
}

/**
 * Opens a document `sealSessionPayload` wrote: authenticates every field but
 * the tag and ciphertext under `key`, then decrypts and checks the payload.
 * An IV, tag, or ciphertext that is not a string, any tag but 16 bytes, a wrong key, or an edited byte is
 * `SESSION_INVALID` with `messages.authFailed`; a payload of another shape
 * is `SESSION_INVALID` with `messages.invalidPayload`. Neither error carries
 * the plaintext.
 */
export function openSessionPayload(
  envelope: { readonly state: SealedState },
  key: Buffer,
  messages: { readonly authFailed: string; readonly invalidPayload: string },
): SessionPayload {
  const { tag, ciphertext, ...aadState } = envelope.state;
  let plaintext: string;
  try {
    // Inside the try: `canonicalJson` throws on a value JSON cannot carry, such as an unknown field of 1e400.
    const aad = Buffer.from(canonicalJson({ ...envelope, state: aadState }), 'utf8');
    // Strings only: `Buffer.from` also takes the tag as an array of bytes.
    if (![envelope.state.iv, tag, ciphertext].every((field: unknown) => typeof field === 'string')) throw new TypeError('the IV, tag, and ciphertext must be strings');
    // A fixed tag length: GCM would otherwise accept a truncated tag, which is easier to forge.
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.state.iv, 'base64'), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch (cause) {
    throw new ConfigurationError('SESSION_INVALID', messages.authFailed, { cause });
  }
  return parseSessionPayload(plaintext, messages.invalidPayload);
}

/**
 * Collects states saved by one setup attempt and owns the setup session
 * contract: each declared name saved exactly once, nothing undeclared.
 */
export class SessionStaging {
  private readonly staged = new Map<string, SavedSession>();

  constructor(private readonly declared: readonly string[]) {}

  /** Stages one captured state with the secret values of the session it came from, rejecting duplicate or undeclared names. */
  stage(name: string, state: EngineState, secrets: SavedSecrets): void {
    if (this.staged.has(name)) {
      throw new E2EError('test', 'SESSION_CONTRACT', `session "${name}" saved twice`);
    }
    if (!this.declared.includes(name)) {
      throw new E2EError(
        'test',
        'SESSION_CONTRACT',
        `session "${name}" was not declared by this setup test`,
      );
    }
    this.staged.set(name, { state, secrets });
  }

  /** Declared names the attempt finished without saving. */
  missing(): string[] {
    return this.declared.filter((name) => !this.staged.has(name));
  }

  entries(): IterableIterator<[string, SavedSession]> {
    return this.staged.entries();
  }
}

/** Holds the per-run AES-256-GCM key in memory and owns the session directory. */
export class SessionStore {
  private readonly key: Buffer;
  private readonly directory: string;
  /** Decrypted states by target and name; see `load`. */
  private readonly loaded = new Map<string, Promise<SavedSession>>();

  private constructor(
    private readonly runId: string,
    sessionsRoot: string,
    key: Buffer,
  ) {
    this.key = key;
    this.directory = path.join(sessionsRoot, runId);
  }

  /** Opens the store for a new run, generating its key. */
  static create(runId: string, sessionsRoot: string): SessionStore {
    return new SessionStore(runId, sessionsRoot, randomBytes(32));
  }

  /** Opens the store in a worker, reusing the key the runner generated. */
  static forWorker(runId: string, sessionsRoot: string, key: Buffer): SessionStore {
    if (key.length !== 32) {
      throw new E2EError('infrastructure', 'SESSION_KEY_INVALID', 'session key must be 32 bytes');
    }
    return new SessionStore(runId, sessionsRoot, key);
  }

  /** Base64 key for transfer to worker processes over IPC (never disk/env). */
  exportKeyForWorker(): string {
    return this.key.toString('base64');
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  private filePath(targetId: string, name: string): string {
    const digest = createHash('sha256')
      .update(`${targetId}\u0000${name}`)
      .digest('hex')
      .slice(0, 16);
    return path.join(
      this.directory,
      `${fileNamePart(targetId)}--${fileNamePart(name)}-${digest}.json`,
    );
  }

  /**
   * Encrypts and atomically persists one captured engine state. The secret
   * values the saving session learned ride inside the ciphertext, beside the
   * state they may be stored in, so the session that restores it redacts
   * them too; the envelope names them in the clear, authenticated.
   */
  async save(name: string, identity: SessionIdentity, { state, secrets }: SavedSession): Promise<void> {
    this.ensureDirectory();
    const now = Date.now();
    const createdAt = timestamp(new Date(now));
    let expiryMs = now + MAX_SESSION_AGE_MS;
    if (state.expiresAt !== undefined) {
      const stateExpiry = Date.parse(state.expiresAt);
      if (Number.isNaN(stateExpiry) || stateExpiry <= now) {
        throw new E2EError('test', 'SESSION_EXPIRED', 'state expiry is at or before creation');
      }
      if (stateExpiry < expiryMs) expiryMs = stateExpiry;
    }
    const expiresAt = new Date(expiryMs).toISOString();

    const envelope: SessionEnvelope = sealSessionPayload(
      {
        schemaVersion: 'session-1' as const,
        runId: this.runId,
        name,
        targetId: identity.targetId,
        engine: {
          name: identity.engineName,
          version: identity.engineVersion,
          spiVersion: identity.spiVersion,
        },
        platform: identity.platform,
        appIdentity: identity.appIdentity,
        createdAt,
        expiresAt,
      },
      state,
      secrets,
      this.key,
    );

    const target = this.filePath(identity.targetId, name);
    await writeFileAtomic(target, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Validates identity and expiry, then decrypts one session state. A
   * session is immutable for the life of the run that produced it, so the
   * decrypted state is memoized per store: a worker running many consumers
   * of one session reads and decrypts its file once. Its expiry is still
   * checked on every load: an immutable state can expire between consumers.
   */
  async load(name: string, identity: SessionIdentity): Promise<SavedSession> {
    const memoKey = `${identity.targetId}\u0000${name}`;
    const cached = this.loaded.get(memoKey);
    if (cached !== undefined) {
      const saved = await cached;
      assertSessionNotExpired(name, saved.state.expiresAt);
      return saved;
    }
    const loading = this.loadUncached(name, identity);
    this.loaded.set(memoKey, loading);
    try {
      return await loading;
    } catch (cause) {
      this.loaded.delete(memoKey);
      throw cause;
    }
  }

  private async loadUncached(name: string, identity: SessionIdentity): Promise<SavedSession> {
    let rawText: string;
    try {
      rawText = await readFile(this.filePath(identity.targetId, name), 'utf8');
    } catch (cause) {
      throw new ConfigurationError('SESSION_UNAVAILABLE', `session "${name}" was not produced`, {
        cause,
      });
    }
    const envelope = parseEnvelope(rawText, name);
    if (
      envelope.schemaVersion !== 'session-1' ||
      envelope.runId !== this.runId ||
      envelope.targetId !== identity.targetId ||
      envelope.engine.name !== identity.engineName ||
      envelope.engine.version !== identity.engineVersion ||
      envelope.engine.spiVersion !== identity.spiVersion ||
      envelope.platform !== identity.platform ||
      envelope.appIdentity !== identity.appIdentity
    ) {
      throw new ConfigurationError(
        'SESSION_MISMATCH',
        `session "${name}" does not match the current run/target/engine identity`,
      );
    }
    assertSessionNotExpired(name, envelope.expiresAt);

    const payload = openSessionPayload(envelope, this.key, {
      authFailed: `session "${name}" failed authentication`,
      invalidPayload: `session "${name}" has an unexpected payload`,
    });
    return {
      state: {
        format: envelope.state.format,
        version: envelope.state.version,
        data: payload.data,
        expiresAt: envelope.expiresAt,
      },
      secrets: payload.secrets,
    };
  }

  /** Deletes the run's session directory. */
  cleanup(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Refuses an expired saved session, whether freshly decrypted or already cached. */
function assertSessionNotExpired(name: string, expiresAt: string | undefined): void {
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()) {
    throw new ConfigurationError('SESSION_EXPIRED', `session "${name}" is expired`);
  }
}

const FILE_NAME_PART_MAX = 40;

/**
 * The readable prefix of a session file name for one of its parts: every
 * character outside `[A-Za-z0-9_]`, `-` and `.` included, becomes `%XX`, so
 * the part carries no path separator or `..` segment, then the result is cut
 * to a fixed length. A session name may be 128 characters and a target name
 * any length, and the escape triples a dash, so the cut keeps the whole file
 * name, with the atomic-write suffix, far under the 255-byte component limit.
 * The digest `filePath` appends is what tells two pairs apart, so target
 * `a--b` with session `c` and target `a` with session `b--c` are two files
 * even where their prefixes agree.
 */
function fileNamePart(value: string): string {
  return Array.from(Buffer.from(value, 'utf8'), (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9_]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  })
    .join('')
    .slice(0, FILE_NAME_PART_MAX);
}

/** Parses an envelope file, classifying a corrupt or truncated one as SESSION_INVALID. */
function parseEnvelope(rawText: string, name: string): SessionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new ConfigurationError('SESSION_INVALID', `session "${name}" is not valid JSON`, {
      cause,
    });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { state?: unknown }).state !== 'object' ||
    (parsed as { state: unknown }).state === null ||
    typeof (parsed as { engine?: unknown }).engine !== 'object' ||
    (parsed as { engine: unknown }).engine === null
  ) {
    throw new ConfigurationError('SESSION_INVALID', `session "${name}" has an unexpected shape`);
  }
  return parsed as SessionEnvelope;
}

/** Parses an authenticated payload; one `sealSessionPayload` did not write is SESSION_INVALID. */
function parseSessionPayload(text: string, invalidMessage: string): SessionPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // No cause: a JSON syntax error quotes the text it failed on, here the decrypted payload.
    throw new ConfigurationError('SESSION_INVALID', invalidMessage);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('data' in parsed) ||
    !('secrets' in parsed) ||
    !Array.isArray(parsed.secrets) ||
    !parsed.secrets.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === 'string'),
    )
  ) {
    throw new ConfigurationError('SESSION_INVALID', invalidMessage);
  }
  return parsed as SessionPayload;
}
