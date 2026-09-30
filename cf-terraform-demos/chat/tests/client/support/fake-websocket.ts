/**
 * @file A controllable `WebSocket` stand-in for room-store tests. jsdom has no WebSocket server to
 *   connect to, and a real one would make these tests depend on timing. This double lets a test
 *   drive the connection explicitly: open it, deliver a frame, close it with a chosen code, and
 *   inspect what was sent.
 */

/**
 * A fake connection, matching the small part of the `WebSocket` API the room store uses.
 */
export class FakeWebSocket {
  /**
   * Every fake created since the last {@link installFakeWebSocket}, in creation order. A reconnect
   * creates a new one, so this array is also the reconnection history.
   */
  static instances: FakeWebSocket[] = [];

  /**
   * The URL the store asked to connect to, asserted on to prove the socket path and scheme are
   * built correctly.
   */
  readonly url: string;

  /**
   * Payloads passed to {@link FakeWebSocket.send}, in order.
   */
  readonly sent: string[] = [];

  /**
   * Matches `WebSocket.CONNECTING`.
   */
  static readonly CONNECTING = 0;

  /**
   * Matches `WebSocket.OPEN`.
   */
  static readonly OPEN = 1;

  /**
   * Matches `WebSocket.CLOSING`.
   */
  static readonly CLOSING = 2;

  /**
   * Matches `WebSocket.CLOSED`.
   */
  static readonly CLOSED = 3;

  /**
   * Current state, using the same numeric constants as the real API so the store's `readyState !==
   * WebSocket.OPEN` guard behaves identically.
   */
  readyState: number = FakeWebSocket.CONNECTING;

  /**
   * Whether the store asked to close this socket, which distinguishes a deliberate disconnect from
   * a drop.
   */
  closedByClient = false;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  /**
   * @param url URL the store connected to. Coerced to a string exactly as the real constructor
   *   does, because the store passes a `URL` object and a test asserting on `.url` should see what
   *   a browser would.
   */
  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  /**
   * Register an event listener.
   *
   * @param type Event name.
   * @param listener Handler to invoke.
   */
  addEventListener(type: string, listener: (event: never) => void): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener as (event: unknown) => void);
    this.listeners.set(type, existing);
  }

  /**
   * Remove an event listener.
   *
   * @param type Event name.
   * @param listener Handler to remove.
   */
  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener as (event: unknown) => void);
  }

  /**
   * Record an outgoing payload.
   *
   * @param payload Serialized frame the store sent.
   */
  send(payload: string): void {
    this.sent.push(payload);
  }

  /**
   * Record that the store asked to close, without dispatching a close event.
   *
   * Real close events arrive asynchronously, so a test drives the resulting event itself with
   * {@link FakeWebSocket.simulateClose}. Separating the two is what lets a test assert on the
   * store's state between requesting a close and the close completing.
   */
  close(): void {
    this.closedByClient = true;
    this.readyState = FakeWebSocket.CLOSING;
  }

  /**
   * Complete the connection handshake.
   */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  /**
   * Deliver one frame to the store.
   *
   * @param frame Value to deliver; serialized as JSON unless already a string, so a test can also
   *   deliver deliberately malformed data.
   */
  simulateMessage(frame: unknown): void {
    this.dispatch('message', {
      data: typeof frame === 'string' ? frame : JSON.stringify(frame)
    });
  }

  /**
   * Close the connection from the server side.
   *
   * @param code Close code; defaults to a normal closure.
   */
  simulateClose(code = 1_000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', { code });
  }

  /**
   * Invoke every listener registered for an event.
   *
   * @param type Event name.
   * @param event Event payload.
   */
  private dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/**
 * Replace the global `WebSocket` with {@link FakeWebSocket} and clear the instance history.
 *
 * @returns Nothing; call from a `beforeEach` and pair with {@link mostRecentSocket}.
 */
export function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

/**
 * Read the most recently created fake connection.
 *
 * @returns The newest fake.
 * @throws {Error} When no connection has been opened, which means the test's assumption about the
 *   store connecting is wrong and should fail loudly rather than as `undefined`.
 */
export function mostRecentSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error('Expected the store to have opened a connection.');
  }
  return socket;
}
