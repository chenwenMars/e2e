/**
 * Ctrl-C for `@e2e-dev/core` hosts: on SIGINT, SIGTERM, or SIGHUP every host that
 * asked for it (`handleSignals`, on by default) closes, so the browsers and
 * device sessions it launched do not outlive the program. The signal is then
 * raised again for the process's own disposition, unless the program listens
 * for it itself, in which case its listener decides.
 *
 * An engine may listen too: a browser driver closes its browsers on SIGHUP,
 * and its listener outlives the close by a moment. A listener registered
 * while a host or a session opened is the engine's (`engineListeners`), never
 * the program's, so it neither holds the process nor swallows the signal.
 */

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type Closer = () => Promise<unknown>;

const closers = new Set<Closer>();
let installed = false;
/** Signal listeners that appeared while an engine was opening; see the header. */
const engineOwned = new Set<unknown>();

/**
 * Marks the signal listeners registered between this call and the returned
 * function's as an engine's. Call it around what launches the engine's
 * processes: opening a host, opening a session.
 */
export function engineListeners(): () => void {
  const before = new Set<unknown>(SIGNALS.flatMap((signal) => process.listeners(signal)));
  return () => {
    for (const signal of SIGNALS) {
      for (const listener of process.listeners(signal)) if (!before.has(listener) && listener !== onSignal) engineOwned.add(listener);
    }
  };
}

/** Closes every registered host once, then hands the signal back to the process. */
function onSignal(signal: NodeJS.Signals): void {
  uninstall();
  // The process ends right after, so a close that failed is said on stderr or nowhere; its message is already redacted.
  const pending = [...closers].map((close) => close().catch((cause: unknown) => {
    process.stderr.write(`@e2e-dev/core: closing a host on ${signal} failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }));
  closers.clear();
  void Promise.allSettled(pending).then(() => {
    const listeners = process.listeners(signal);
    if (listeners.some((listener) => !engineOwned.has(listener))) return;
    // The hosts are closed, so an engine's listener has nothing left to close, and left in place it would take the signal.
    for (const listener of listeners) process.off(signal, listener);
    process.kill(process.pid, signal);
  });
}

function install(): void {
  if (installed) return;
  installed = true;
  for (const signal of SIGNALS) process.on(signal, onSignal);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  for (const signal of SIGNALS) process.off(signal, onSignal);
}

/** Registers a host's close for the process signals; the returned function unregisters it. */
export function closeOnSignals(close: Closer): () => void {
  closers.add(close);
  install();
  return () => {
    closers.delete(close);
    if (closers.size === 0) uninstall();
  };
}
