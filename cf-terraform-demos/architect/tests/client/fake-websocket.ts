/**
 * @file A controllable `WebSocket` stand-in for the editor's live-sync tests. jsdom has no
 *   WebSocket implementation to connect with, and a real one would make these tests depend on
 *   timing. This double lets a test drive the connection explicitly: deliver a frame, close it, and
 *   inspect what the canvas did in response. The real socket — the hibernatable one, with the
 *   Durable Object on the other end — is exercised against `workerd` in
 *   `../integration/live-sync.test.ts`; what these tests own is the canvas's reaction to a frame.
 */

/**
 * A fake connection, matching the small part of the `WebSocket` API the canvas uses.
 */
export class FakeWebSocket {
  /**
   * Every fake created since the last {@link installFakeWebSocket}, in creation order. Opening a
   * second diagram creates a new one, so this array is also the connection history — which is how a
   * test proves the canvas closed one socket before opening another.
   */
  static instances: FakeWebSocket[] = [];

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
   * The URL the canvas asked to connect to, asserted on to prove the path and scheme are built
   * correctly.
   */
  readonly url: string;

  /**
   * Payloads passed to {@link FakeWebSocket.send}, in order.
   *
   * The canvas writes exactly one thing today — a resync request, when it detects it can no longer
   * apply operations safely — so a test that expects silence is asserting something real rather
   * than relying on a channel that cannot be written to.
   */
  readonly sent: string[] = [];

  /**
   * Whether the canvas asked to close this socket, which is how an unmount is asserted.
   */
  closedByClient = false;

  /**
   * Current state, using the same numeric constants as the real API.
   *
   * Starts **open**, which is a deliberate simplification rather than an oversight. A real socket
   * is `CONNECTING` until its handshake completes, but nothing in these tests exercises that window
   * — every test delivers a frame, which a real socket could only do once open. Leaving it
   * `CONNECTING` would instead make the canvas's own `readyState` guards silently skip, so a test
   * asserting the canvas sent nothing would pass for the wrong reason.
   */
  readyState: number = FakeWebSocket.OPEN;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  /**
   * @param url URL the canvas connected to. Coerced to a string exactly as the real constructor
   *   does, so a test asserting on `.url` sees what a browser would.
   */
  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  /**
   * Registers an event listener.
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
   * Removes an event listener.
   *
   * @param type Event name.
   * @param listener Handler to remove.
   */
  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener as (event: unknown) => void);
  }

  /**
   * Records an outgoing payload.
   *
   * @param payload Frame the canvas sent, which it never should.
   */
  send(payload: string): void {
    this.sent.push(payload);
  }

  /**
   * Records that the canvas asked to close.
   */
  close(): void {
    this.closedByClient = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  /**
   * Simulates the connection becoming open.
   *
   * @returns Nothing.
   */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  /**
   * Simulates the connection becoming unavailable without the canvas initiating it.
   *
   * @returns Nothing.
   */
  simulateServerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  /**
   * Simulates a connection error.
   *
   * @returns Nothing.
   */
  simulateError(): void {
    this.dispatch('error', {});
  }

  /**
   * Delivers one frame to the canvas.
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
   * Whether this socket still has any message listener attached.
   *
   * Used to prove the canvas detaches its handler on unmount rather than only closing the socket: a
   * listener left behind would keep the component's closure — and the diagram it captured — alive
   * for as long as the tab is open.
   *
   * @returns `true` when at least one `message` listener remains.
   */
  hasMessageListener(): boolean {
    return (this.listeners.get('message')?.size ?? 0) > 0;
  }

  /**
   * Invokes every listener registered for an event.
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
 * Replaces the global `WebSocket` with {@link FakeWebSocket} and clears the instance history.
 *
 * @returns Nothing; call it from a `beforeEach` and pair it with {@link mostRecentSocket}.
 */
export function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

/**
 * Reads the most recently created fake connection.
 *
 * @returns The newest fake.
 * @throws {Error} When no connection has been opened, which means the test's assumption about the
 *   canvas connecting is wrong and should fail loudly rather than as `undefined`.
 */
export function mostRecentSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error('Expected the canvas to have opened a connection.');
  }
  return socket;
}
