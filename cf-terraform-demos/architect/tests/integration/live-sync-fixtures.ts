import { env, exports } from 'cloudflare:workers';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * @file Shared helpers for the live-sync suite. They exist so each test reads as the sequence it is
 *   asserting — connect, call a tool, wait for the push — rather than as request plumbing, and so
 *   every wait on a socket is bounded in one place. The literal `Host` and origin below are
 *   fictional, so nothing in this suite can reach a real deployment.
 */

/**
 * Audience the Worker accepts, matching `ACCESS_AUD` in `./vitest.config.ts`.
 */
export const AUD = 'a'.repeat(64);

/**
 * Fictional origin: never a live deployment, so this suite cannot touch an account resource.
 */
export const ORIGIN = 'https://diagrams.test';

/**
 * One ordinary diagram owner.
 */
export const ALICE = 'alice@example.com';

/**
 * A different owner, used to prove a non-owner cannot connect.
 */
export const MALLORY = 'mallory@example.com';

/**
 * The identity header the Worker sets on an upgrade forwarded to a session.
 *
 * Spelled as a literal here rather than imported from
 * `../../src/worker/infrastructure/session-protocol.ts`, deliberately. These tests play the part of
 * a hostile client, and a client does not import the server's constants — it guesses the header
 * name, which for a demo whose source is public is not a guess at all. Writing it out is what makes
 * the test a genuine attempt rather than a tautology against whatever the server currently calls
 * the header.
 */
export const SMUGGLED_IDENTITY_HEADER = 'X-Architect-Identity';

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
 * Runs an async assertion with a fixture Workers AI binding installed.
 *
 * `env` substitution is process-wide in this pool and survives Durable Object eviction, not a
 * per-instance convenience. The `finally` is therefore load-bearing: without it an unrelated later
 * test sees this fake binding and fails for a reason nowhere near the test that leaked it.
 *
 * @param fakeAi Fixture to expose as the otherwise-undeclared `AI` binding.
 * @param body Test work to run while the fixture is installed.
 * @returns The result of `body`.
 * @throws {Error} Any error `body` throws, after the original binding has been restored.
 */
export async function withFakeAi<T>(fakeAi: unknown, body: () => Promise<T>): Promise<T> {
  const bindings = testEnv as TestEnv & { AI?: unknown };
  const original = bindings.AI;
  bindings.AI = fakeAi;
  try {
    return await body();
  } finally {
    bindings.AI = original;
  }
}

/**
 * Dispatches a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
export async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/**
 * Builds a request carrying a development Access JWT for one identity.
 *
 * @param path API path to request.
 * @param init Additional request options; same-origin browser signals are added so the
 *   `enforceSameOriginJson` middleware treats the request as the browser call it stands in for.
 * @param email Identity to sign the token for.
 * @returns A request ready to dispatch through the Worker.
 */
export async function requestAs(
  path: string,
  init: RequestInit = {},
  email: string = ALICE
): Promise<Request> {
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, await signDevJwt(email, { audience: AUD }));
  headers.set('Sec-Fetch-Site', 'same-origin');
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

/**
 * Creates a diagram through the real API, exactly as its owner would.
 *
 * Tests never insert rows directly: going through the route means a fixture cannot set up state the
 * application itself could never produce.
 *
 * @param email Identity that will own the diagram.
 * @param title Title to give it.
 * @returns The new diagram's id.
 * @throws {Error} When creation fails, so a broken fixture fails at its own call site rather than
 *   as a confusing assertion failure later.
 */
export async function createDiagram(email: string = ALICE, title = 'Live'): Promise<string> {
  const response = await send(
    await requestAs('/api/diagrams', { body: JSON.stringify({ title }), method: 'POST' }, email)
  );
  if (response.status !== 201) {
    throw new Error(`Fixture could not create a diagram: HTTP ${response.status}`);
  }
  return ((await response.json()) as { diagram: { id: string } }).diagram.id;
}

/**
 * Replaces a diagram's whole graph through the real autosave route.
 *
 * @param diagramId Diagram to write to.
 * @param graph Graph value to store.
 * @param email Identity performing the save.
 * @returns The new `updatedAt` timestamp the route reported.
 * @throws {Error} When the save fails.
 */
export async function saveGraph(
  diagramId: string,
  graph: unknown,
  email: string = ALICE
): Promise<string> {
  const response = await send(
    await requestAs(
      `/api/diagrams/${diagramId}/graph`,
      { body: JSON.stringify({ graphData: JSON.stringify(graph) }), method: 'PUT' },
      email
    )
  );
  if (response.status !== 200) {
    throw new Error(`Fixture could not save a graph: HTTP ${response.status}`);
  }
  return ((await response.json()) as { updatedAt: string }).updatedAt;
}

/**
 * Reads a diagram's stored graph straight from D1.
 *
 * Reading storage rather than watching a socket is how a test proves something was _not_ written,
 * without racing a push against a timeout.
 *
 * @param diagramId Diagram to read.
 * @returns The stored canonical graph JSON, or `null` when the row is gone.
 */
export async function storedGraph(diagramId: string): Promise<string | null> {
  const row = await testEnv.DB.prepare('SELECT graph_data FROM diagrams WHERE id = ?')
    .bind(diagramId)
    .first<{ graph_data: string }>();
  return row?.graph_data ?? null;
}

/**
 * Opens a live WebSocket to a diagram through the real, fully-authenticated Worker route.
 *
 * @param diagramId Diagram to connect to.
 * @param email Identity to connect as.
 * @param extraHeaders Additional headers to send on the upgrade, used by the test that proves a
 *   client cannot smuggle its own identity header.
 * @returns The accepted client-side socket.
 * @throws {Error} When the upgrade does not succeed, which would otherwise surface as a confusing
 *   null-socket failure later.
 */
export async function openSocket(
  diagramId: string,
  email: string = ALICE,
  extraHeaders: Record<string, string> = {}
): Promise<WebSocket> {
  const response = await send(
    await requestAs(
      `/api/diagrams/${diagramId}/live`,
      { headers: { Upgrade: 'websocket', ...extraHeaders } },
      email
    )
  );
  if (response.status !== 101 || response.webSocket === null) {
    throw new Error(`Could not open a socket to "${diagramId}": HTTP ${response.status}`);
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
 * own timeout and reporting only that the test was slow. Generous enough that a loaded machine
 * never trips it: every wait in this suite is satisfied by a local Worker-to-Durable-Object hop.
 */
const FRAME_TIMEOUT_MS = 5_000;

/**
 * Rejects a pending socket wait once {@link FRAME_TIMEOUT_MS} elapses.
 *
 * A WebSocket has no equivalent of a failed HTTP response to reject on, so a frame that is never
 * sent leaves a bare promise pending forever and the whole suite hangs rather than failing.
 * Wrapping every wait means the worst case is a fast, explanatory failure.
 *
 * @typeParam T Value the underlying wait resolves to.
 * @param pending The wait to bound.
 * @param description What was being waited for, used verbatim in the timeout message.
 * @param socket Socket being waited on, so the failure can report whether it was still open — which
 *   distinguishes "the session never sent this" from "the connection had already gone".
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
    // Always cleared, including on the success path: a timer left pending would keep the runtime
    // alive past the end of the suite and delay the pool's shutdown.
    clearTimeout(timer);
  }
}

/**
 * Waits for the next frame of a given type, ignoring any others.
 *
 * Filtering by type rather than taking the literal next frame is what keeps these tests from
 * depending on frame order — the `connected` acknowledgement routinely interleaves with whatever a
 * test is actually waiting for.
 *
 * **Prefer {@link recordFrames} for anything a connection might already have sent.** This function
 * only sees frames that arrive after it is called, so a test that connects, triggers a change and
 * then waits has a race it will lose intermittently. Attaching the recorder at connect time removes
 * that class of flake rather than making each test remember to attach early.
 *
 * @param socket Socket to read from.
 * @param type Frame discriminator to wait for.
 * @returns The first matching frame.
 * @throws {Error} When no matching frame arrives within {@link FRAME_TIMEOUT_MS}, naming the frame
 *   type so the failure says what was missing rather than only that time ran out.
 */
export function nextFrameOfType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  const received = new Promise<Record<string, unknown>>((resolve) => {
    const handler = (event: MessageEvent): void => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type === type) {
        socket.removeEventListener('message', handler);
        resolve(frame);
      }
    };
    socket.addEventListener('message', handler);
  });

  return withTimeout(received, `a "${type}" frame`, socket);
}

/**
 * Everything one connection has received, and a way to wait for more.
 */
export interface FrameRecorder {
  /**
   * Every frame received so far, in arrival order.
   */
  readonly frames: Record<string, unknown>[];
  /**
   * Waits for the next frame of a type **beyond those already consumed**.
   *
   * Each call continues where the last left off, so a test can assert a sequence of frames in order
   * without re-matching one it has already examined — which is what a plain "find the first frame
   * of this type" would do on the second call.
   *
   * @param type Frame discriminator to wait for.
   * @returns The next matching frame.
   * @throws {Error} When none arrives within {@link FRAME_TIMEOUT_MS}.
   */
  next(type: string): Promise<Record<string, unknown>>;
}

/**
 * Records every frame a socket receives, from the moment it is attached.
 *
 * Attached at connect time, which is the point: the session sends a snapshot the instant a
 * connection is accepted, and anything a test does next may produce a frame before that test has
 * had a chance to start listening. Buffering removes that race rather than asking every test to win
 * it.
 *
 * @param socket Socket to record.
 * @returns The recorder; see {@link FrameRecorder}.
 */
export function recordFrames(socket: WebSocket): FrameRecorder {
  const frames: Record<string, unknown>[] = [];
  // Resolvers for `next` calls that are waiting on a frame which has not arrived yet.
  const waiting: { type: string; resolve: (frame: Record<string, unknown>) => void }[] = [];
  // How far into `frames` each type has been consumed, so consecutive `next` calls advance
  // through a sequence rather than repeatedly matching its first entry.
  const consumed = new Map<string, number>();

  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    frames.push(frame);

    const index = waiting.findIndex((entry) => entry.type === frame.type);
    if (index !== -1) {
      const [entry] = waiting.splice(index, 1);
      consumed.set(frame.type as string, frames.length);
      entry?.resolve(frame);
    }
  });

  return {
    frames,
    next(type) {
      const from = consumed.get(type) ?? 0;
      const buffered = frames.findIndex((frame, index) => index >= from && frame.type === type);
      if (buffered !== -1) {
        consumed.set(type, buffered + 1);
        return Promise.resolve(frames[buffered] as Record<string, unknown>);
      }

      return withTimeout(
        new Promise<Record<string, unknown>>((resolve) => {
          waiting.push({ resolve, type });
        }),
        `a "${type}" frame`,
        socket
      );
    }
  };
}

/**
 * Asserts that no frame of a given type arrives within a short window.
 *
 * Proving a negative over a socket needs a bounded wait, and this makes that bound explicit and
 * short: the window only has to be long enough for a push that _would_ have happened to arrive, and
 * every push in this suite is a local hop. Prefer reading storage directly where that is possible —
 * {@link storedGraph} is deterministic rather than time-based — and reserve this for behaviour that
 * has no storage footprint, such as cross-diagram delivery.
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

/**
 * Modern MCP's per-request envelope, matching the fixture in `./mcp.test.ts`.
 */
const MCP_ENVELOPE = {
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/protocolVersion': '2026-07-28'
};

/**
 * Calls one MCP tool as a verified identity, through the real `/mcp` endpoint.
 *
 * It sets no `Origin` or `Sec-Fetch-Site`, exactly as a real MCP client does not — so a tool call
 * reaching a session proves the documented same-origin carve-out as a side effect.
 *
 * @param email Identity to authenticate as.
 * @param name Registered tool name.
 * @param args Tool arguments.
 * @returns The parsed JSON-RPC payload.
 */
export async function callTool(
  email: string,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await send(
    new Request(`${ORIGIN}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { _meta: MCP_ENVELOPE, arguments: args, name }
      }),
      headers: {
        'accept': 'application/json, text/event-stream',
        'content-type': 'application/json',
        'host': 'diagrams.test',
        'mcp-method': 'tools/call',
        'mcp-name': name,
        [JWT_HEADER]: await signDevJwt(email, { audience: AUD })
      },
      method: 'POST'
    })
  );

  return (await response.json()) as Record<string, unknown>;
}

/**
 * Reads the first text content block from a successful `tools/call` payload.
 *
 * @param body Parsed JSON-RPC response payload.
 * @returns The text the tool returned.
 * @throws {Error} When the response is not a successful text-bearing tool result, so a failure is
 *   reported at the call that produced it rather than at an unrelated parse later.
 */
export function toolText(body: Record<string, unknown>): string {
  const result = body.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string' || result?.isError === true) {
    throw new Error(`Expected a successful MCP tool result, received ${JSON.stringify(body)}.`);
  }
  return text;
}
