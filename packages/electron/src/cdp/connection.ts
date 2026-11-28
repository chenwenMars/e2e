/**
 * The DevTools protocol on the wire: one connection to a browser or a Node
 * inspector, and the flat sessions of the targets attached over it. Commands
 * and events are typed by `devtools-protocol`.
 */

import type { Readable, Writable } from 'node:stream';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';

type Commands = ProtocolMapping.Commands;
type Events = ProtocolMapping.Events;

/** A protocol command's failure: the method that failed and the protocol's own error code. */
export class ProtocolError extends Error {
  readonly method: string;
  readonly code: number | undefined;

  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}`);
    this.name = 'ProtocolError';
    this.method = method;
    this.code = code;
  }
}

/** Carries whole protocol messages in both directions. */
export interface Transport {
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message: string };
  readonly sessionId?: string;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly method: string;
  readonly sessionId: string;
}

/** One message off the wire, or undefined for one that is not a protocol message. */
function readMessage(raw: string): Message | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { id, method, params, result, error, sessionId } = parsed as Record<string, unknown>;
  const failure = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  return {
    ...(typeof id === 'number' ? { id } : {}),
    ...(typeof method === 'string' ? { method } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    params,
    result,
    ...(failure === undefined ? {} : { error: { message: String(failure['message']), ...(typeof failure['code'] === 'number' ? { code: failure['code'] } : {}) } }),
  };
}

/**
 * The pipe a browser started with `--remote-debugging-pipe` reads commands
 * from (its fd 3) and writes to (its fd 4): JSON messages, each ended by a
 * NUL byte. No port is opened, so no other process can connect.
 */
export function pipeTransport(write: Writable, read: Readable): Transport {
  const messageHandlers: ((message: string) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let buffered: Buffer[] = [];
  read.on('data', (chunk: Buffer) => {
    let start = 0;
    let end = chunk.indexOf(0);
    while (end !== -1) {
      buffered.push(chunk.subarray(start, end));
      const message = Buffer.concat(buffered).toString('utf8');
      buffered = [];
      for (const handler of messageHandlers) handler(message);
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) buffered.push(chunk.subarray(start));
  });
  // Either half ending or failing ends the connection: a command the browser can no longer read has no answer coming.
  const closed = (): void => {
    for (const handler of closeHandlers) handler();
  };
  read.on('close', closed);
  read.on('error', closed);
  write.on('close', closed);
  write.on('error', closed);
  return {
    send: (message) => {
      write.write(`${message}\0`);
    },
    onMessage: (handler) => void messageHandlers.push(handler),
    onClose: (handler) => void closeHandlers.push(handler),
    close: () => {
      write.end();
      read.destroy();
    },
  };
}

/** A WebSocket endpoint, such as the one a Node inspector listens on; rejects when it cannot be reached within `timeoutMs`. */
export async function webSocketTransport(url: string, timeoutMs: number): Promise<Transport> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no answer from ${url} within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`cannot connect to ${url}`));
    }, { once: true });
  });
  return {
    send: (message) => socket.send(message),
    onMessage: (handler) => socket.addEventListener('message', (event) => handler(String(event.data))),
    onClose: (handler) => socket.addEventListener('close', () => handler()),
    close: () => socket.close(),
  };
}

/**
 * One connection. Sessions are flat (`Target.attachToTarget` with
 * `flatten: true`): every target's traffic shares the transport and is
 * routed by its session id.
 */
export class Connection {
  /** The session of the endpoint itself: the browser, or a Node process. */
  readonly root: Session;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<string, Session>();
  private closed = false;

  constructor(private readonly transport: Transport) {
    this.root = new Session(this, '');
    transport.onMessage((raw) => {
      let message: Message | undefined;
      try {
        message = readMessage(raw);
      } catch {
        // A frame that is not JSON means the stream is out of step, and no later answer can be trusted.
        this.close();
        return;
      }
      if (message !== undefined) this.dispatch(message);
    });
    transport.onClose(() => this.handleClose());
  }

  /** The session of an attached target, by the id `Target.attachToTarget` answered with. */
  session(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      session = new Session(this, sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  send(method: string, params: unknown, sessionId: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new ProtocolError(method, 'connection closed'));
    const id = this.nextId++;
    this.transport.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId === '' ? {} : { sessionId }) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, sessionId });
    });
  }

  /** Closes the transport; every pending command fails. */
  close(): void {
    this.transport.close();
    this.handleClose();
  }

  private dispatch(message: Message): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new ProtocolError(pending.method, message.error.message, message.error.code));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === undefined) return;
    const session = message.sessionId === undefined ? this.root : this.sessions.get(message.sessionId);
    if (message.method === 'Target.detachedFromTarget') this.forget((message.params as { readonly sessionId: string }).sessionId);
    session?.emit(message.method, message.params ?? {});
  }

  /** Drops a detached session. The browser never answers its pending commands, so they fail here rather than hang. */
  private forget(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(id);
      pending.reject(new ProtocolError(pending.method, 'session detached'));
    }
    session?.markDetached();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new ProtocolError(pending.method, 'connection closed'));
    this.pending.clear();
    for (const session of this.sessions.values()) session.markDetached();
    this.sessions.clear();
  }
}

/** One flat protocol session: the endpoint itself (an empty id) or an attached target. */
export class Session {
  private detached = false;
  private readonly listeners = new Map<string, Set<(params: never) => void>>();

  constructor(
    private readonly connection: Connection,
    readonly id: string,
  ) {}

  send<M extends keyof Commands>(method: M, ...params: Commands[M]['paramsType']): Promise<Commands[M]['returnType']> {
    if (this.detached) return Promise.reject(new ProtocolError(method, 'session detached'));
    return this.connection.send(method, params[0], this.id) as Promise<Commands[M]['returnType']>;
  }

  /** Listens for a protocol event of this session; returns the unsubscribe. */
  on<E extends keyof Events>(event: E, handler: (params: Events[E][0]) => void): () => void {
    let handlers = this.listeners.get(event);
    if (handlers === undefined) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
    return () => void handlers.delete(handler);
  }

  emit(event: string, params: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) (handler as (params: unknown) => void)(params);
  }

  markDetached(): void {
    this.detached = true;
    this.listeners.clear();
  }
}
