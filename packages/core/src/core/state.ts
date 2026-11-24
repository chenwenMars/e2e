/**
 * `SessionState`: what an `@e2e-dev/core` session's `saveState()` captures (the
 * engine's cookies, storage, or app data), held in memory. It leaves the
 * process only encrypted, under a key the caller holds, as a `session-state-1`
 * document; there is no plaintext export.
 */

import type { EngineState } from '../engine/index.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { rejectUnknownOptions } from '../internal/options.ts';
import { timestamp } from '../internal/ids.ts';
import type { RestoredState } from '../run/engine-sessions.ts';
import type { SavedSecrets } from '../run/secrecy.ts';
import { openSessionPayload, sealSessionPayload, type SealedState } from '../run/sessions.ts';

/** What a state is bound to: it restores only on a host of the same engine, platform, and app. */
export interface StateIdentity {
  readonly engine: string;
  readonly platform: string;
  readonly appIdentity: string;
  /** The app as a message names it: its URL, bundle id, or declared identity. Absent on an imported state, whose document holds the digest alone. */
  readonly app?: string;
}

/** The `session-state-1` wire format, pinned by `schema/session-state-v1.schema.json`. */
interface StateDocument {
  schemaVersion: 'session-state-1';
  engine: string;
  platform: string;
  appIdentity: string;
  createdAt: string;
  expiresAt?: string;
  /** Authenticated, never encrypted: which secrets the payload carries values for. */
  secrecy: { names: string[] };
  state: SealedState;
}

const KEY_BYTES = 32;
const KEY_OPTION_KEYS = ['key'] as const;

/** The options of `export` and `import`: the AES-256-GCM key, 32 bytes the caller keeps. */
export interface SessionStateKeyOptions {
  readonly key: Uint8Array;
}

const held = new WeakMap<SessionState, { readonly identity: StateIdentity; readonly saved: RestoredState }>();

/**
 * A captured session state. Pass it to `host.newSession({ state })` to start
 * a session from it, on a host of the same engine, platform, and app.
 */
export class SessionState {
  /** The engine that captured it, by name. */
  readonly engine: string;
  /** The platform it was captured on. */
  readonly platform: string;

  private constructor(identity: StateIdentity, saved: RestoredState) {
    this.engine = identity.engine;
    this.platform = identity.platform;
    held.set(this, { identity, saved });
    Object.freeze(this);
  }

  /**
   * Encrypts the state with `key` (AES-256-GCM, 32 bytes) into a
   * `session-state-1` document, as UTF-8 bytes. The document names the
   * engine, the platform, a digest of the app, and the names of the secrets
   * in the clear, authenticated; everything the state holds, secret values
   * included, is in the ciphertext.
   */
  // oxlint-disable-next-line typescript/require-await -- async so a bad key rejects instead of throwing
  async export(options: SessionStateKeyOptions): Promise<Uint8Array> {
    rejectUnknownOptions('SessionState.export', options, KEY_OPTION_KEYS);
    const key = requireKey(options, 'SessionState.export');
    const { identity, saved } = held.get(this)!;
    const document: StateDocument = sealSessionPayload(
      {
        schemaVersion: 'session-state-1' as const,
        engine: identity.engine,
        platform: identity.platform,
        appIdentity: identity.appIdentity,
        createdAt: timestamp(),
        ...(saved.state.expiresAt === undefined ? {} : { expiresAt: timestamp(new Date(saved.state.expiresAt)) }),
      },
      saved.state,
      saved.secrets,
      key,
    );
    return new TextEncoder().encode(`${JSON.stringify(document)}\n`);
  }

  /**
   * Decrypts a document `export` wrote. A document that is not
   * `session-state-1`, or that fails authentication under `key` (a wrong
   * key, an edited byte), is `SESSION_INVALID`; an expired one is
   * `SESSION_EXPIRED`.
   */
  // oxlint-disable-next-line typescript/require-await -- async so a bad document rejects instead of throwing
  static async import(data: Uint8Array, options: SessionStateKeyOptions): Promise<SessionState> {
    rejectUnknownOptions('SessionState.import', options, KEY_OPTION_KEYS);
    const key = requireKey(options, 'SessionState.import');
    if (!(data instanceof Uint8Array)) throw new TestError('INVALID_ARGUMENT', 'SessionState.import data must be a Uint8Array');
    const document = parseDocument(new TextDecoder().decode(data));
    if (document.expiresAt !== undefined && Date.parse(document.expiresAt) <= Date.now()) {
      throw new ConfigurationError('SESSION_EXPIRED', 'the session state is expired');
    }
    const payload = openSessionPayload(document, key, {
      authFailed: 'the session state failed authentication: a different key, or the document was changed',
      invalidPayload: 'the session state has an unexpected payload',
    });
    return new SessionState(
      { engine: document.engine, platform: document.platform, appIdentity: document.appIdentity },
      {
        state: {
          format: document.state.format,
          version: document.state.version,
          data: payload.data,
          ...(document.expiresAt === undefined ? {} : { expiresAt: document.expiresAt }),
        },
        secrets: payload.secrets,
      },
    );
  }

  /** A state a session just captured. */
  static captured(identity: StateIdentity, state: EngineState, secrets: SavedSecrets): SessionState {
    return new SessionState(identity, { state, secrets });
  }
}

/**
 * What a host restores from `state`, checked against the host's own identity:
 * another engine, platform, or app is `SESSION_MISMATCH`, an expired state
 * `SESSION_EXPIRED`.
 */
export function restoredStateFor(state: unknown, host: StateIdentity): RestoredState {
  const entry = state instanceof SessionState ? held.get(state) : undefined;
  if (entry === undefined) throw new TestError('INVALID_ARGUMENT', 'newSession state must be a SessionState from saveState() or SessionState.import()');
  const { identity, saved } = entry;
  if (identity.engine !== host.engine || identity.platform !== host.platform) {
    throw new ConfigurationError(
      'SESSION_MISMATCH',
      `the session state was saved on engine ${identity.engine} (${identity.platform}), and this host runs ${host.engine} (${host.platform}); a state restores only on the engine and platform that saved it`,
    );
  }
  if (identity.appIdentity !== host.appIdentity) {
    throw new ConfigurationError(
      'SESSION_MISMATCH',
      `the session state was saved for ${identity.app ?? 'another app'}, and this host drives ${host.app ?? 'an app with no URL or bundle id'}; a state restores only on the app it was saved for. ` +
        'When both are one app at two addresses, give both hosts the same app.identity',
    );
  }
  if (saved.state.expiresAt !== undefined && Date.parse(saved.state.expiresAt) <= Date.now()) {
    throw new ConfigurationError('SESSION_EXPIRED', 'the session state is expired');
  }
  return saved;
}

function requireKey(options: SessionStateKeyOptions | undefined, api: string): Buffer {
  const key: unknown = options?.key;
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new TestError('INVALID_ARGUMENT', `${api} key must be a Uint8Array of ${KEY_BYTES} bytes, such as crypto.randomBytes(${KEY_BYTES})`);
  }
  return Buffer.from(key);
}

const isString = (value: unknown): value is string => typeof value === 'string';
/** A 12-byte IV and a 16-byte tag in base64, as `schema/session-state-v1.schema.json` pins them. */
const IV_PATTERN = /^[A-Za-z0-9+/]{16}$/u;
const TAG_PATTERN = /^[A-Za-z0-9+/]{22}==$/u;

/** Parses a document's clear part; anything `export` would not have written is `SESSION_INVALID`. */
function parseDocument(text: string): StateDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigurationError('SESSION_INVALID', 'the session state is not valid JSON', { cause });
  }
  const document = parsed as Partial<StateDocument> | null;
  const state = typeof document?.state === 'object' ? document.state as Partial<StateDocument['state']> | null : undefined;
  if (
    typeof document !== 'object' || document === null ||
    document.schemaVersion !== 'session-state-1' ||
    !isString(document.engine) || !isString(document.platform) || !isString(document.appIdentity) || !isString(document.createdAt) ||
    (document.expiresAt !== undefined && !isString(document.expiresAt)) ||
    typeof document.secrecy !== 'object' || document.secrecy === null || !Array.isArray(document.secrecy.names) || !document.secrecy.names.every(isString) ||
    typeof state !== 'object' || state === null ||
    !isString(state.format) || !Number.isInteger(state.version) || state.algorithm !== 'A256GCM' ||
    !isString(state.iv) || !IV_PATTERN.test(state.iv) || !isString(state.tag) || !TAG_PATTERN.test(state.tag) || !isString(state.ciphertext)
  ) {
    throw new ConfigurationError('SESSION_INVALID', 'the session state is not a session-state-1 document');
  }
  return document as StateDocument;
}
