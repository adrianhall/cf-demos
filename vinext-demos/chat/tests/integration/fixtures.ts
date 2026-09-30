import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * A verified identity used wherever a test does not care who is acting.
 */
export const ALICE = 'alice@example.com';

/**
 * A second verified identity, used wherever a test needs two distinguishable participants.
 */
export const BOB = 'bob@example.com';

/**
 * The audience the Worker is configured to accept, matching `ACCESS_AUD` in `./vitest.config.ts`.
 */
export const AUD = 'a'.repeat(64);

/**
 * Test-only bindings injected by the integration Vitest project.
 */
interface TestEnv extends Env {
  /**
   * Parsed D1 migrations used to build the schema in Miniflare's otherwise empty database.
   */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/**
 * The Workers environment, widened to include the test-only migration binding.
 */
export const testEnv = env as TestEnv;

/**
 * Build a request carrying a development Access JWT for one identity.
 *
 * @param path API path to request.
 * @param init Additional request options; a JSON content type is added when a body is present.
 * @param email Identity to sign the token for.
 * @param audience Audience to mint the token for. Defaults to the audience the Worker accepts; a
 *   test overrides it to prove cross-application tokens are refused.
 * @returns A request ready to dispatch through the Worker.
 */
export async function requestAs(
  path: string,
  init: RequestInit = {},
  email: string = ALICE,
  audience: string = AUD
): Promise<Request> {
  const token = await signDevJwt(email, { audience });
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, token);
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return new Request(`https://chat.example${path}`, { ...init, headers });
}

/**
 * Dispatch a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
export async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/**
 * Create a channel through the real API, exactly as a participant would.
 *
 * Tests never insert directory rows directly: going through the route means the fixture exercises
 * the same validation and storage path the application uses, so a fixture cannot set up state the
 * application itself could never produce.
 *
 * @param name Channel name to create.
 * @param email Identity creating the channel.
 * @returns The created channel's normalized name.
 * @throws {Error} When creation fails, so a broken fixture fails at its own call site rather than
 *   as a confusing assertion failure later.
 */
export async function createChannel(name: string, email: string = ALICE): Promise<string> {
  const response = await send(
    await requestAs('/api/channels', { body: JSON.stringify({ name }), method: 'POST' }, email)
  );
  if (response.status !== 201) {
    throw new Error(`Fixture could not create channel "${name}": HTTP ${response.status}`);
  }
  return ((await response.json()) as { channel: { name: string } }).channel.name;
}

/**
 * List the channel directory through the real API.
 *
 * @param email Identity making the request.
 * @returns Every channel name, in the order the API returned them.
 */
export async function listChannelNames(email: string = ALICE): Promise<string[]> {
  const response = await send(await requestAs('/api/channels', {}, email));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { channels: { name: string }[] };
  return body.channels.map((channel) => channel.name);
}

/**
 * Generate a channel name unique to one test.
 *
 * Durable Object storage survives eviction — only `destroy()` erases it — so reusing a name across
 * tests would leak one test's messages into another's history. The value is kept short and
 * lowercase so it satisfies the domain's own name rules.
 *
 * @returns A fresh, valid channel name.
 */
export function uniqueChannelName(): string {
  return `test-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Open an authenticated WebSocket to a channel through the real Worker route.
 *
 * @param channel Channel to join; must already exist in the directory.
 * @param email Identity to connect as.
 * @param extraHeaders Additional headers to send on the upgrade, used by the test that proves a
 *   client cannot smuggle its own identity header.
 * @returns The accepted client-side socket.
 * @throws {Error} When the upgrade does not succeed, which would otherwise surface as a confusing
 *   null-socket failure.
 */
export async function openSocket(
  channel: string,
  email: string = ALICE,
  extraHeaders: Record<string, string> = {}
): Promise<WebSocket> {
  const response = await send(
    await requestAs(
      `/api/channels/${encodeURIComponent(channel)}/socket`,
      { headers: { Upgrade: 'websocket', ...extraHeaders } },
      email
    )
  );
  if (response.status !== 101 || response.webSocket === null) {
    throw new Error(`Could not open a socket to "${channel}": HTTP ${response.status}`);
  }
  const socket = response.webSocket;
  socket.accept();
  return socket;
}

/**
 * How long any single wait for a socket event may take before it is treated as a failure.
 *
 * Deliberately shorter than the project's `testTimeout` (see `./vitest.config.ts`) so a frame that
 * never arrives fails _here_, naming the frame and the socket state, instead of tripping Vitest's
 * own timeout and reporting only that the test was too slow. Generous enough that a loaded machine
 * never trips it: every wait in this suite is satisfied by a local Worker-to-Durable-Object hop,
 * which completes in milliseconds.
 */
const FRAME_TIMEOUT_MS = 5_000;

/**
 * Reject a pending socket wait once {@link FRAME_TIMEOUT_MS} elapses.
 *
 * A WebSocket has no equivalent of a failed HTTP response to reject on, so a frame that is never
 * sent leaves a bare promise pending forever — the whole suite then hangs rather than failing.
 * Wrapping every wait means the worst case is a fast, explanatory failure.
 *
 * @typeParam T Value the underlying wait resolves to.
 * @param pending The wait to bound.
 * @param description What was being waited for, used verbatim in the timeout message.
 * @param socket Socket being waited on, so the failure can report whether it was still open — which
 *   distinguishes "the room never sent this" from "the connection had already gone".
 * @returns The awaited value.
 * @throws {Error} When the wait does not settle within {@link FRAME_TIMEOUT_MS}.
 */
async function withTimeout<T>(
  pending: Promise<T>,
  description: string,
  socket: WebSocket
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out after ${FRAME_TIMEOUT_MS}ms waiting for ${description} `
            + `(socket readyState ${socket.readyState}).`
        )
      );
    }, FRAME_TIMEOUT_MS);
  });

  try {
    return await Promise.race([pending, expiry]);
  } finally {
    // Always cleared, including on the success path: a timer left pending would keep the
    // runtime alive past the end of the suite and delay the pool's shutdown.
    clearTimeout(timer);
  }
}

/**
 * Wait for the next frame of a given type, ignoring any others.
 *
 * Frames a test does not care about — a presence update triggered by somebody else joining —
 * routinely interleave with the one it is waiting for, so filtering by type rather than taking the
 * literal next frame is what keeps these tests from being order-dependent.
 *
 * @param socket Socket to read from.
 * @param type Frame discriminator to wait for.
 * @returns The first matching frame.
 * @throws {Error} When no matching frame arrives within {@link FRAME_TIMEOUT_MS}, naming the frame
 *   type so the failure says what was missing rather than only that time ran out.
 */
export function nextFrameOfType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return nextFrameMatching(socket, type, () => true);
}

/**
 * Wait for the next frame of a given type that also satisfies a predicate.
 *
 * Filtering by type alone is not always enough. A socket routinely receives frames of the type a
 * test is waiting for that describe an _earlier_ state — most commonly the presence frame the room
 * sends on the test's own join, which is dispatched before the listener attaches but delivered
 * after it. Waiting for the frame that reports the state under test, rather than the next one of
 * that type, removes that race without resorting to a sleep.
 *
 * @param socket Socket to read from.
 * @param type Frame discriminator to wait for.
 * @param matches Predicate the frame must also satisfy.
 * @param description What is being waited for, used in the timeout message.
 * @returns The first matching frame.
 * @throws {Error} When no matching frame arrives within {@link FRAME_TIMEOUT_MS}.
 */
export function nextFrameMatching(
  socket: WebSocket,
  type: string,
  matches: (frame: Record<string, unknown>) => boolean,
  description = `a "${type}" frame`
): Promise<Record<string, unknown>> {
  const received = new Promise<Record<string, unknown>>((resolve) => {
    const handler = (event: MessageEvent): void => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type === type && matches(frame)) {
        socket.removeEventListener('message', handler);
        resolve(frame);
      }
    };
    socket.addEventListener('message', handler);
  });

  return withTimeout(received, description, socket);
}

/**
 * Wait for the room to report a specific participant count.
 *
 * @param socket Socket to read from.
 * @param participants Count to wait for.
 * @returns A promise fulfilled once that count is reported.
 * @throws {Error} When the count is never reported within {@link FRAME_TIMEOUT_MS}.
 */
export function nextPresenceOf(socket: WebSocket, participants: number): Promise<unknown> {
  return nextFrameMatching(
    socket,
    'presence',
    (frame) => frame.participants === participants,
    `presence reporting ${participants} participant(s)`
  );
}

/**
 * Wait for a socket to close.
 *
 * @param socket Socket to watch.
 * @returns The close event, whose `code` distinguishes an intentional channel removal from any
 *   other closure.
 * @throws {Error} When the socket does not close within {@link FRAME_TIMEOUT_MS}.
 */
export function nextClose(socket: WebSocket): Promise<CloseEvent> {
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener('close', (event) => resolve(event), { once: true });
  });

  return withTimeout(closed, 'the socket to close', socket);
}

/**
 * Assert that no frame of a given type arrives within a short window.
 *
 * Proving a negative over a socket needs a bounded wait, and this makes that bound explicit and
 * short: the window only has to be long enough for a broadcast that _would_ have happened to
 * arrive, and every broadcast in this suite is a local hop. Prefer reading Durable Object storage
 * directly where that is possible — it is deterministic rather than time-based — and reserve this
 * for behaviour that has no storage footprint, such as cross-channel delivery.
 *
 * @param socket Socket that must stay quiet.
 * @param type Frame discriminator that must not arrive.
 * @param windowMs How long to watch for.
 * @returns A promise fulfilled once the window has passed without a matching frame.
 * @throws {Error} When a matching frame does arrive, reporting its contents.
 */
export async function expectNoFrameOfType(
  socket: WebSocket,
  type: string,
  windowMs = 250
): Promise<void> {
  let unexpected: Record<string, unknown> | undefined;
  const handler = (event: MessageEvent): void => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (frame.type === type) {
      unexpected = frame;
    }
  };

  socket.addEventListener('message', handler);
  try {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
  } finally {
    socket.removeEventListener('message', handler);
  }

  if (unexpected !== undefined) {
    throw new Error(`Unexpected "${type}" frame: ${JSON.stringify(unexpected)}`);
  }
}
