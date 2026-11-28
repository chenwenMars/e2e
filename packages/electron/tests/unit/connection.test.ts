import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Connection, pipeTransport, ProtocolError, type Transport } from '../../src/cdp/connection.ts';

/** A transport whose other end the test plays: what was sent, and a way to answer. */
function fakeTransport(): { readonly transport: Transport; readonly sent: { id: number; method: string; params: unknown; sessionId?: string }[]; receive(message: object): void; drop(): void } {
  const sent: { id: number; method: string; params: unknown; sessionId?: string }[] = [];
  let onMessage: (message: string) => void = () => undefined;
  let onClose: () => void = () => undefined;
  return {
    sent,
    transport: {
      send: (message) => void sent.push(JSON.parse(message)),
      onMessage: (handler) => {
        onMessage = handler;
      },
      onClose: (handler) => {
        onClose = handler;
      },
      close: () => undefined,
    },
    receive: (message) => onMessage(JSON.stringify(message)),
    drop: () => onClose(),
  };
}

describe('Connection', () => {
  it('matches each answer to its command, and routes a session\'s commands by its id', async () => {
    const { transport, sent, receive } = fakeTransport();
    const connection = new Connection(transport);
    const version = connection.root.send('Browser.getVersion');
    const title = connection.session('S1').send('Runtime.evaluate', { expression: 'document.title' });
    expect(sent).toEqual([
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Runtime.evaluate', params: { expression: 'document.title' }, sessionId: 'S1' },
    ]);
    receive({ id: 2, result: { result: { type: 'string', value: 'Hi' } } });
    receive({ id: 1, result: { product: 'Chrome/1' } });
    expect((await title).result.value).toBe('Hi');
    expect((await version).product).toBe('Chrome/1');
  });

  it('fails a command with the protocol\'s own message and code', async () => {
    const { transport, receive } = fakeTransport();
    const connection = new Connection(transport);
    const resolved = connection.root.send('DOM.resolveNode', { backendNodeId: 7 });
    receive({ id: 1, error: { code: -32000, message: 'No node with given id found' } });
    const error = await resolved.then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error).toMatchObject({ method: 'DOM.resolveNode', code: -32000, message: 'DOM.resolveNode: No node with given id found' });
  });

  it('sends an event to the listeners of its session only, until they unsubscribe', () => {
    const { transport, receive } = fakeTransport();
    const connection = new Connection(transport);
    const seen: string[] = [];
    const stop = connection.session('S1').on('Page.loadEventFired', () => seen.push('S1'));
    connection.session('S2').on('Page.loadEventFired', () => seen.push('S2'));
    connection.root.on('Target.targetDestroyed', ({ targetId }) => seen.push(targetId));
    receive({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S1' });
    receive({ method: 'Target.targetDestroyed', params: { targetId: 'T' } });
    stop();
    receive({ method: 'Page.loadEventFired', params: { timestamp: 2 }, sessionId: 'S1' });
    expect(seen).toEqual(['S1', 'T']);
  });

  it('fails the pending commands of a session that detached, which the browser never answers', async () => {
    const { transport, receive } = fakeTransport();
    const connection = new Connection(transport);
    const session = connection.session('S1');
    const pending = session.send('Accessibility.getFullAXTree');
    const other = connection.root.send('Browser.getVersion');
    receive({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } });
    await expect(pending).rejects.toThrow('Accessibility.getFullAXTree: session detached');
    await expect(session.send('Page.enable')).rejects.toThrow(/session detached/);
    receive({ id: 2, result: { product: 'Chrome/1' } });
    expect((await other).product).toBe('Chrome/1');
  });

  it('fails everything pending, and everything sent after, when the transport closes', async () => {
    const { transport, drop } = fakeTransport();
    const connection = new Connection(transport);
    const pending = connection.root.send('Browser.getVersion');
    drop();
    await expect(pending).rejects.toThrow('Browser.getVersion: connection closed');
    await expect(connection.root.send('Browser.getVersion')).rejects.toThrow(/connection closed/);
  });
});

describe('a broken stream', () => {
  it('closes the connection on a frame that is not JSON, failing what is pending', async () => {
    const write = new PassThrough();
    const read = new PassThrough();
    const connection = new Connection(pipeTransport(write, read));
    const pending = connection.root.send('Browser.getVersion');
    read.write('{"id":1,"result"\0');
    await expect(pending).rejects.toThrow(/connection closed/);
    await expect(connection.root.send('Browser.getVersion')).rejects.toThrow(/connection closed/);
  });

  it('closes the connection when the browser can no longer be written to', async () => {
    const write = new PassThrough();
    const connection = new Connection(pipeTransport(write, new PassThrough()));
    const pending = connection.root.send('Browser.getVersion');
    write.destroy(new Error('write EPIPE'));
    await expect(pending).rejects.toThrow(/connection closed/);
  });
});

describe('pipeTransport', () => {
  it('ends each message with a NUL, and reads messages split or joined across chunks', () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const written: Buffer[] = [];
    toBrowser.on('data', (chunk: Buffer) => written.push(chunk));
    const transport = pipeTransport(toBrowser, fromBrowser);
    const received: string[] = [];
    transport.onMessage((message) => received.push(message));
    transport.send('{"id":1}');
    expect(Buffer.concat(written).toString()).toBe('{"id":1}\0');
    fromBrowser.emit('data', Buffer.from('{"a":1}\0{"b":'));
    fromBrowser.emit('data', Buffer.from('"é"}\0'));
    expect(received).toEqual(['{"a":1}', '{"b":"é"}']);
  });
});
