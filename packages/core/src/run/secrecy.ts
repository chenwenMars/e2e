/** What one live session knows about secrets: the values to redact. */

import type { ResolvedConfig } from '../config/resolve.ts';
import { MIN_SECRET_LENGTH, secretLength } from '../config/secrets.ts';
import type { TargetSession } from '../engine/surface.ts';
import { sharedSecretsBrand } from '../internal/brands.ts';
import { ConfigurationError, setErrorRedactor } from '../internal/errors.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { SecretLedger, type SecretList, type SecretsBeside } from '../internal/redact.ts';
import { unavailableCode } from '../secrets.ts';
import type { Secret } from '../types.ts';

/**
 * Whether captured pixels are proven redacted: the engine masked at least as
 * many regions as the secure nodes it observed. Pixels that are not leave no
 * session, whoever asked for them.
 */
export function pixelsProvenMasked(redaction: { readonly secureNodeCount: number; readonly maskedRegionCount: number }): boolean {
  return redaction.maskedRegionCount >= redaction.secureNodeCount;
}

/**
 * Whether a text-like download of the session is rewritten through its
 * ledger before it is kept: whenever the ledger redacts a value, its own or
 * one shared beside it. A value reaches the app in ways the runner never
 * sees (a URL or a `fill` the test spelled it into, the app's own config, a
 * session open beside this one), so downloads are redacted like every
 * report and observation, not only after a fill.
 */
export function redactsDownloads(ledger: SecretLedger): boolean {
  return ledger.redactsAnything;
}

/**
 * What the sessions in one process share about secrets. A value typed into
 * one session reaches the others through the app, and through the text a
 * test builds from what it read, so a session that redacted only its own
 * values would print another's: a test's own session and the `launch()`
 * host the test opened beside it, a browser and a phone alike. Every owner
 * of values (a run's config, an open host, an open session) shares them for
 * as long as it lives, and every ledger redacts what is shared beside it
 * without storing it: what a session carries into a saved state stays its
 * own. A value leaves when its last owner does, so a session's ledger, which
 * redacts every screen the session observes, is not matched against every
 * one-time code a worker has minted. `processSecrets` alone keeps them all.
 *
 * Held on `globalThis`, not in module state: a project that installs
 * `@e2e-dev/core` beside `e2e` can load two copies of this module, and a
 * host of one copy must still reach the sessions of the other. Plain data,
 * so two versions agree on its shape.
 */
interface SharedSecrets {
  /** Every value shared now, by name and value, with how many owners share it. */
  readonly values: Map<string, { readonly entry: readonly [string, string]; owners: number }>;
  /** Counts the times a value appeared or disappeared; one more owner of a value already shared changes nothing. */
  revision: number;
}

const sharedSlot = realmSlot<SharedSecrets>(sharedSecretsBrand);

function shared(): SharedSecrets {
  let state = sharedSlot.get(globalThis);
  if (state === undefined) {
    state = { values: new Map(), revision: 0 };
    sharedSlot.set(globalThis, state);
  }
  return state;
}

/** One owner's share of values: more are added as it learns them, and all leave when it withdraws. */
interface Sharing {
  add(name: string, value: string): void;
  withdraw(): void;
}

/** Shares `entries` with every ledger in the process, on behalf of one owner. */
function share(entries: SecretList): Sharing {
  const state = shared();
  const mine = new Set<string>();
  const add = (name: string, value: string): void => {
    const key = `${name}\0${value}`;
    if (mine.has(key)) return;
    mine.add(key);
    const held = state.values.get(key);
    if (held !== undefined) {
      held.owners += 1;
      return;
    }
    state.values.set(key, { entry: [name, value], owners: 1 });
    state.revision += 1;
  };
  for (const [name, value] of entries) add(name, value);
  return {
    add,
    withdraw: () => {
      for (const key of mine) {
        const held = state.values.get(key);
        if (held === undefined) continue;
        held.owners -= 1;
        if (held.owners > 0) continue;
        state.values.delete(key);
        state.revision += 1;
      }
      mine.clear();
    },
  };
}

const beside: SecretsBeside = {
  get revision() {
    return shared().revision;
  },
  values: () => [...shared().values.values()].map((held) => held.entry),
};

/**
 * Every secret value any session in this process has seen, for text the
 * process itself emits rather than a session: a test's console output leaves
 * the worker through here. Holds the static values as they are declared;
 * provider-backed values join as they resolve.
 */
export const processSecrets = new SecretLedger([], beside);

function staticEntries(secrets: ResolvedConfig['allSecrets']): SecretList {
  return [...secrets].flatMap(([name, { value }]) => (typeof value === 'string' ? [[name, value] as const] : []));
}

/** The static ledger of each secrets map, built once. */
const staticLedgers = new WeakMap<ResolvedConfig['allSecrets'], SecretLedger>();

/**
 * A ledger of the static values of `secrets` alone, built once per map. What
 * text produced before any session exists is redacted with, such as a test
 * title at collection: every process resolving the same config redacts it
 * alike, so a test's id agrees between the runner and its workers. A
 * provider-backed value is not known yet and is not in it. Shared, so it is
 * handed out read-only: nothing registers into it.
 */
export function staticSecretLedger(secrets: ResolvedConfig['allSecrets']): Pick<SecretLedger, 'redact' | 'entries' | 'redactFragments'> {
  let ledger = staticLedgers.get(secrets);
  if (ledger === undefined) {
    ledger = new SecretLedger(staticEntries(secrets));
    staticLedgers.set(secrets, ledger);
  }
  return ledger;
}

/** Makes `processSecrets` `serializeError`'s default redactor and seeds it with the static values of `secrets`, which it returns. */
function seedProcess(secrets: ResolvedConfig['allSecrets']): SecretList {
  setErrorRedactor(processSecrets.redact);
  const entries = staticSecretLedger(secrets).entries();
  for (const [name, value] of entries) processSecrets.register(name, value);
  return entries;
}

/**
 * Shares the static values of `secrets` with every session in the process
 * from now on, and seeds `processSecrets` with them, so output before any
 * session opens is covered too. What a run does with its config: the
 * sessions of a `launch()` host a test opens redact its values.
 */
export function registerStaticSecrets(secrets: ResolvedConfig['allSecrets']): void {
  share(seedProcess(secrets));
}

/**
 * Shares the static values of `secrets` until the returned function is
 * called: what a `launch()` host does while it is open, so a session beside
 * it redacts them before the host opens a session of its own, and between
 * two.
 */
export function shareStaticSecrets(secrets: ResolvedConfig['allSecrets']): () => void {
  return share(seedProcess(secrets)).withdraw;
}

/** What each session ledger shares with the ledgers beside it, until its session ends. */
const sharingByLedger = new WeakMap<SecretLedger, Sharing>();

/**
 * Registers a value one session came to know while it ran (a provider's
 * value, a form an engine derived, a value a saved session carried) in its
 * ledger and the process ledger, and shares it with the sessions open
 * beside it from this moment.
 */
function learn(ledger: SecretLedger, name: string, value: string): void {
  if (ledger.register(name, value)) sharingByLedger.get(ledger)?.add(name, value);
  processSecrets.register(name, value);
}

/**
 * The plaintext of one configured secret, a provider's value computed fresh.
 * The value joins `ledger` and `processSecrets` before it is returned, so it
 * is redacted from the moment it exists, whoever it is handed to.
 */
export async function resolveSecretValue(
  secret: Secret,
  secrets: ResolvedConfig['allSecrets'],
  ledger: SecretLedger,
): Promise<string> {
  const registered = secrets.get(secret.name);
  if (registered === undefined) {
    throw new ConfigurationError(unavailableCode(secret), `secret "${secret.name}" is not configured`);
  }
  const value = registered.value;
  const plaintext = typeof value === 'function' ? await value() : value;
  if (typeof plaintext !== 'string' || secretLength(plaintext) < MIN_SECRET_LENGTH) {
    throw new ConfigurationError(
      unavailableCode(secret),
      `secret "${secret.name}" provider did not return a string of at least ${MIN_SECRET_LENGTH} characters (code points)`,
    );
  }
  learn(ledger, secret.name, plaintext);
  return plaintext;
}

/**
 * Registers the forms an engine derived from one resolved secret (the base64
 * basic-auth credential) under the secret's name, in `ledger` and in
 * `processSecrets`, so what the app sees in place of the value is redacted
 * wherever the value is. Registered before the engine hands a form to the
 * app, since the resolve that computes them has not returned yet.
 */
export function registerDerivedSecrets(name: string, derived: readonly string[], ledger: SecretLedger): void {
  for (const value of derived) {
    if (typeof value !== 'string' || value === '') continue;
    learn(ledger, name, value);
  }
}

/** Secrets survive every fixture graph that shares the same live isolation. */
const ledgerBySession = new WeakMap<TargetSession, SecretLedger>();

/**
 * Every secret value one session may have seen, created on first use and
 * shared by every attempt that borrows the session (a serial group's
 * members). Seeded with the static secret values known up front;
 * provider-backed values join through the resolver the moment they exist.
 * Its values are shared with the sessions open beside it until
 * `releaseSessionLedger`, and it redacts theirs.
 */
export function sessionLedger(
  session: TargetSession,
  secrets: ResolvedConfig['allSecrets'],
): SecretLedger {
  let ledger = ledgerBySession.get(session);
  if (ledger === undefined) {
    const own = seedProcess(secrets);
    ledger = new SecretLedger(own, beside);
    sharingByLedger.set(ledger, share(own));
    ledgerBySession.set(session, ledger);
  }
  return ledger;
}

/**
 * Stops sharing what `session` knows, once it has ended: its values are its
 * own again, redacted by its own ledger in what is still reported of it.
 */
export function releaseSessionLedger(session: TargetSession): void {
  const ledger = ledgerBySession.get(session);
  if (ledger !== undefined) sharingByLedger.get(ledger)?.withdraw();
}

/**
 * Redacts `text` with every value `session` has seen, or with the process
 * ledger while no session is open yet, so text an attempt produces before
 * its session exists (a step label, a fixture error) is covered too.
 */
export function redactForSession(
  session: TargetSession | undefined,
  secrets: ResolvedConfig['allSecrets'],
  text: string,
): string {
  return session === undefined ? processSecrets.redact(text) : sessionLedger(session, secrets).redact(text);
}

/** Name and value pairs a saved session carries beyond the static config values; they travel only inside the encrypted payload. */
export type SavedSecrets = readonly (readonly [string, string])[];

/**
 * The values a session envelope carries: the provider-resolved values the
 * session learned, which the consumer's session cannot learn again on its
 * own. Static config values are left out; every session registers those
 * itself.
 */
export function carriedSecrets(ledger: SecretLedger, secrets: ResolvedConfig['allSecrets']): SavedSecrets {
  return ledger.entries().filter(([name, value]) => secrets.get(name)?.value !== value);
}

/** Seeds a restored session's ledger with what the saving session knew, so a value the restored state echoes back is still redacted. */
export function adoptSecrets(ledger: SecretLedger, saved: SavedSecrets): void {
  for (const [name, value] of saved) learn(ledger, name, value);
}
