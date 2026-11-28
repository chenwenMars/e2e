/**
 * The app's main process, reached over the Node inspector it opens with
 * `--inspect`: where `electron.evaluate` runs, and where the main process's
 * console is read. An app that opens no inspector has none of this.
 */

import type { Protocol } from 'devtools-protocol';
import { TestError } from '@e2e-dev/core/engine';
import { Connection, webSocketTransport } from './cdp/connection.ts';
import { consoleText } from './console-text.ts';
import type { ElectronMainModule } from './fixtures.ts';

/** What a function run in the main process threw: its own failure, not the engine's. */
export class MainEvaluateError extends Error {}

/** One line the main process wrote to its console. */
export type MainConsole = (type: string, text: string) => void;

export class MainProcess {
  private module: Promise<string> | undefined;

  private constructor(private readonly connection: Connection) {}

  /** Connects to the inspector at `url` and starts reading the main process's console. */
  static async connect(url: string, timeoutMs: number, onConsole: MainConsole): Promise<MainProcess> {
    const connection = new Connection(await webSocketTransport(url, timeoutMs));
    const { root } = connection;
    root.on('Runtime.consoleAPICalled', (event) => {
      // Context 0 is the inspector's own; the app's console calls come from its default context.
      if (event.executionContextId !== 0) onConsole(event.type, consoleText(event.args));
    });
    await root.send('Runtime.enable');
    return new MainProcess(connection);
  }

  /** The main process's `electron` module, held as a remote object for every call to receive. */
  private electronModule(): Promise<string> {
    if (this.module === undefined) {
      const module = (async () => {
        // `require` is in scope only with the command-line API, since Electron 28.
        const { result, exceptionDetails } = await this.connection.root.send('Runtime.evaluate', { expression: "require('electron')", includeCommandLineAPI: true });
        if (exceptionDetails !== undefined || result.objectId === undefined) throw new Error(`the main process has no electron module: ${exceptionDetails === undefined ? result.type : describe(exceptionDetails)}`);
        return result.objectId;
      })();
      this.module = module;
      module.catch(() => {
        if (this.module === module) this.module = undefined;
      });
    }
    return this.module;
  }

  /**
   * Runs `fn` in the main process with its `electron` module and `arg`, and
   * returns what it returns as plain data (`plainData`). `fn` is sent as
   * source text, and `arg` as JSON.
   */
  async evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg: A): Promise<R> {
    try {
      JSON.stringify(arg);
    } catch (cause) {
      throw new TestError('INVALID_ARGUMENT', `electron.evaluate: its argument is not JSON (${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}); pass plain data`, { cause });
    }
    const source = functionSource(fn);
    const objectId = await this.electronModule();
    const { result, exceptionDetails } = await this.connection.root.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `async function (electron, arg) { return (${plainData.toString()})(await (${source})(electron, arg)); }`,
      arguments: [{ objectId }, arg === undefined ? {} : { value: arg }],
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails !== undefined) throw new MainEvaluateError(describe(exceptionDetails));
    // NaN, an infinity, and -0 have no JSON: the protocol names them instead.
    return (result.unserializableValue === undefined ? result.value : Number(result.unserializableValue)) as R;
  }

  /** Disconnects. Node waits for its inspector's clients before it exits, so a quitting app is let go of here. */
  close(): void {
    this.connection.close();
  }
}

/**
 * A function's source as an expression. A method written in shorthand
 * (`{ run() {} }.run`) prints without the `function` keyword, which is put
 * back. The source is only compiled here, never run.
 */
export function functionSource(fn: (...args: never[]) => unknown): string {
  const source = fn.toString();
  if (compiles(source)) return source;
  const method = source.replace(/^(async\s+)?(\*\s*)?/, (_match, async: string | undefined, star: string | undefined) => `${async ?? ''}function ${star ?? ''}`);
  if (compiles(method)) return method;
  throw new TestError('INVALID_ARGUMENT', 'electron.evaluate: its function cannot be sent as source text; pass an arrow function or a function expression');
}

function compiles(source: string): boolean {
  try {
    // oxlint-disable-next-line no-new-func -- compiled to check its syntax, never called
    void new Function(`(${source})`);
    return true;
  } catch {
    return false;
  }
}

function describe(details: Protocol.Runtime.ExceptionDetails): string {
  const { exception } = details;
  if (exception?.description !== undefined) return exception.description.split('\n')[0] ?? details.text;
  return exception?.value === undefined ? details.text : `${details.text} ${String(exception.value)}`;
}

/**
 * A value as the plain data that crosses the protocol: objects and arrays of
 * primitives. A function or a symbol is left out, as is a reference back to
 * an object that holds it, so a `BrowserWindow` or a timer comes back as the
 * plain part of what it is rather than failing the call. Runs in the main
 * process, sent as source text: self-contained.
 */
export function plainData(value: unknown): unknown {
  const holders = new Set<object>();
  const plain = (item: unknown, depth: number): unknown => {
    if (typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item !== 'object' || item === null) return item;
    if (item instanceof Date) return item.toJSON();
    if (holders.has(item) || depth > 32) return undefined;
    holders.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => plain(entry, depth + 1) ?? null);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item)) {
        let entry: unknown;
        try {
          entry = plain((item as Record<string, unknown>)[key], depth + 1);
        } catch {
          // A getter that throws has no value to send.
        }
        // Defined, not assigned: a key named __proto__ is data too.
        if (entry !== undefined) Object.defineProperty(out, key, { value: entry, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      holders.delete(item);
    }
  };
  return plain(value, 0);
}
