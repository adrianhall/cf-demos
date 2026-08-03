import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";

/** Verified identity used by default when a test does not care which participant acts. */
export const ALICE = "alice@example.com";

/** A second verified identity, used to prove per-user chat isolation. */
export const BOB = "bob@example.com";

/**
 * Send one request through the real Worker as a verified Cloudflare Access identity.
 *
 * @param path Request path beginning with `/`.
 * @param init Ordinary `fetch` request options.
 * @param email Verified identity to sign a development Access token for.
 * @returns The Worker's response.
 */
export async function authenticatedRequest(
  path: string,
  init: RequestInit = {},
  email: string = ALICE,
): Promise<Response> {
  const token = await signDevJwt(email);
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, token);
  return exports.default.fetch(
    new Request(`https://agentic-chat.example${path}`, { ...init, headers }),
  );
}

/**
 * Send one request through the real Worker with no Cloudflare Access credentials, exercising
 * the rejection path every protected route must have.
 *
 * @param path Request path beginning with `/`.
 * @param init Ordinary `fetch` request options.
 * @returns The Worker's response.
 */
export async function unauthenticatedRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://agentic-chat.example${path}`, init),
  );
}

/**
 * Create a chat through the real `POST /api/chats` route, matching how a signed-in user creates
 * one in production, so integration tests never insert directory rows directly.
 *
 * @param email Verified identity creating the chat.
 * @returns The new chat's id.
 * @throws {Error} When creation does not succeed, so a broken fixture fails fast at the call
 * site instead of surfacing as a confusing later assertion failure.
 */
export async function createChat(email: string = ALICE): Promise<string> {
  const response = await authenticatedRequest(
    "/api/chats",
    { method: "POST" },
    email,
  );
  if (response.status !== 201) {
    throw new Error(`Fixture failed to create a chat: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { chat: { id: string } };
  return body.chat.id;
}

/**
 * Build a fake `Ai` binding whose `run()` always resolves to a `ReadableStream` of raw Workers
 * AI SSE bytes built from `payloads` -- exactly the shape `workers-ai-provider`'s
 * `doStream()` expects back from `env.AI.run(..., { stream: true })` (confirmed by reading the
 * installed `workers-ai-provider` package's `getMappedStream()`, which decodes the same
 * `data: {"response": "..."}\n\n` / `data: [DONE]\n\n` framing `docs/05-AI-CHAT.md`'s own
 * `createFakeAi()` fixture uses for calling `env.AI.run()` directly).
 *
 * @param payloads Raw `data:` payload strings (JSON chunk text or the literal `"[DONE]"`), in
 * the order they should be streamed.
 * @returns A fake `Ai`-shaped object suitable for {@link withFakeAi}.
 */
export function createFakeAi(payloads: readonly string[]): Pick<Ai, "run"> {
  return {
    run: (async () => {
      const encoder = new TextEncoder();
      const text = payloads.map((payload) => `data: ${payload}\n\n`).join("");
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
      // biome-ignore lint/suspicious/noExplicitAny: matching env.AI.run()'s broad overloaded signature for a test fake is not worth reproducing.
    }) as any,
  };
}

/** What {@link createCapturingFakeAi} recorded about the first call it received. */
export interface CapturedAiCall {
  /** The exact model ID string `env.AI.run()` was called with. */
  readonly modelId: string;
  /** The exact input object `workers-ai-provider` built, before any streaming/parsing. */
  readonly input: Record<string, unknown>;
}

/**
 * Build a fake `Ai` binding identical to {@link createFakeAi}, but that also records the model
 * ID and input object of the **first** call it receives into `capture` -- used to prove
 * `ChatAgent`'s system prompt actually carries the identity `onStart()` captured, something
 * only an end-to-end request through the real Worker and Durable Object can prove.
 *
 * Deliberately captures only the first call: since Phase 3, a completed turn's `onFinish`
 * handler can issue a second, non-streaming `env.AI` call of its own (auto-title generation,
 * `chat-agent.ts`'s `afterTurnCompleted()`) -- capturing every call here would let that second,
 * unrelated call silently overwrite what a test asserted against the first, primary-turn call.
 *
 * @param payloads Raw `data:` payload strings streamed back, exactly as {@link createFakeAi}.
 * @param capture A mutable single-element holder the fake writes its first observed call into.
 * @returns A fake `Ai`-shaped object suitable for {@link withFakeAi}.
 */
export function createCapturingFakeAi(
  payloads: readonly string[],
  capture: { call?: CapturedAiCall },
): Pick<Ai, "run"> {
  return {
    run: ((modelId: string, input: Record<string, unknown>) => {
      capture.call ??= { modelId, input };
      const encoder = new TextEncoder();
      const text = payloads.map((payload) => `data: ${payload}\n\n`).join("");
      return Promise.resolve(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
          },
        }),
      );
      // biome-ignore lint/suspicious/noExplicitAny: matching env.AI.run()'s broad overloaded signature for a test fake is not worth reproducing.
    }) as any,
  };
}

/**
 * Build a fake `Ai` binding whose `run()` branches on the input's own `stream` flag: with
 * `stream: true` (the main turn's `streamText()` call) it behaves exactly like
 * {@link createFakeAi}; without it (Phase 3's auto-title `generateText()` call,
 * `chat-agent.ts`'s `afterTurnCompleted()`) it resolves to a plain, Workers AI "native format"
 * object (`{ response: title }`) -- matching `workers-ai-provider`'s own `processText()`
 * handling of a non-streaming binding response, confirmed by reading the installed package.
 *
 * @param chatPayloads Raw `data:` payload strings for the main turn, exactly as
 * {@link createFakeAi}.
 * @param title The exact text the title-generation call should resolve to.
 * @returns A fake `Ai`-shaped object suitable for {@link withFakeAi}.
 */
export function createFakeAiWithTitle(
  chatPayloads: readonly string[],
  title: string,
): Pick<Ai, "run"> {
  return {
    run: ((_modelId: string, input?: Record<string, unknown>) => {
      if (input?.stream !== true) {
        return Promise.resolve({ response: title });
      }
      const encoder = new TextEncoder();
      const text = chatPayloads
        .map((payload) => `data: ${payload}\n\n`)
        .join("");
      return Promise.resolve(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
          },
        }),
      );
      // biome-ignore lint/suspicious/noExplicitAny: matching env.AI.run()'s broad overloaded signature for a test fake is not worth reproducing.
    }) as any,
  };
}

/**
 * Open an authenticated chat WebSocket through the real Worker route, tracked in `openSockets`
 * for the calling test file's own `afterEach` teardown (per the `testing-durable-objects`
 * skill's lifecycle rules -- every socket a test opens must be tracked and force-closed).
 * Shared by every integration test file that opens a live chat connection.
 *
 * @param chatId Chat to connect to.
 * @param openSockets The calling test file's own tracking `Set`, mutated in place.
 * @param email Verified identity to open the connection as.
 * @returns The accepted client-side `WebSocket`.
 * @throws {Error} When the Worker does not return a WebSocket upgrade.
 */
export async function openChatSocket(
  chatId: string,
  openSockets: Set<WebSocket>,
  email: string = ALICE,
): Promise<WebSocket> {
  const response = await authenticatedRequest(
    `/api/chats/${chatId}/ws`,
    { headers: { Upgrade: "websocket" } },
    email,
  );
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error(
      `Expected a WebSocket upgrade for chat "${chatId}" but got HTTP ${response.status}.`,
    );
  }
  openSockets.add(socket);
  socket.accept();
  return socket;
}

/** One decoded `cf_agent_use_chat_response` frame. */
interface ChatResponseFrame {
  type: string;
  id?: string;
  body?: string;
  done?: boolean;
}

/**
 * Send one chat turn over an already-open, already-accepted socket and resolve with the fully
 * concatenated raw response body once the framework reports `done`. Shared by every integration
 * test file that drives a real turn end to end.
 *
 * @param socket An accepted `ChatAgent` WebSocket (see {@link openChatSocket}).
 * @param text The user turn's text.
 * @returns The concatenated raw `cf_agent_use_chat_response` body chunks for this turn.
 */
export function sendTurn(socket: WebSocket, text: string): Promise<string> {
  const requestId = crypto.randomUUID();
  return new Promise<string>((resolve, reject) => {
    let body = "";
    const timer = setTimeout(() => {
      socket.removeEventListener("message", handler);
      reject(new Error("Timed out waiting for a chat response."));
    }, 8_000);
    function handler(event: MessageEvent): void {
      const parsed = JSON.parse(String(event.data)) as ChatResponseFrame;
      if (
        parsed.type === "cf_agent_use_chat_response" &&
        parsed.id === requestId
      ) {
        body += parsed.body ?? "";
        if (parsed.done) {
          clearTimeout(timer);
          socket.removeEventListener("message", handler);
          resolve(body);
        }
      }
    }
    socket.addEventListener("message", handler);
    socket.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text }],
              },
            ],
            trigger: "submit-message",
          }),
        },
      }),
    );
  });
}

/**
 * Run `callback` with `env.AI` substituted for `fakeAi`, restoring the real binding afterward
 * regardless of outcome (`env`, imported from `cloudflare:workers`, is the same binding object
 * `ChatAgent`'s own `this.env.AI` reads at call time -- confirmed live, since a Durable Object in
 * this test pool runs in the same in-process `workerd` instance as the rest of the test file, not
 * a separately-configured script). `AI_GATEWAY_ID`/`vite dev`'s `remote: true` proxy still
 * attempts to establish a connection to the real account at Miniflare startup (Spike A's Section
 * 8 finding, "Workers AI Has No Local Simulation"), but this substitution means no test in this
 * file ever actually calls it.
 *
 * @param fakeAi A minimal `Ai`-shaped fake; only `run()` needs to be implemented (see
 * {@link createFakeAi}).
 * @param callback Work to run with the fake binding installed.
 * @returns Whatever `callback` resolves to.
 */
export async function withFakeAi<T>(
  fakeAi: Pick<Ai, "run">,
  callback: () => Promise<T>,
): Promise<T> {
  const original = env.AI;
  (env as unknown as { AI: Pick<Ai, "run"> }).AI = fakeAi;
  try {
    return await callback();
  } finally {
    (env as unknown as { AI: Ai }).AI = original;
  }
}

/**
 * Run `callback` with `env.DB` substituted for a proxy that throws only for `ChatAgent`'s own
 * internal, unscoped `chats` queries (`ChatRepository.touch()`/`findById()`/
 * `setTitleIfUnset()` -- every one of which, unlike every client-facing query, has no
 * `owner_email` predicate in its SQL text), delegating every other query to the real D1
 * binding unchanged. Restores the real binding afterward regardless of outcome -- the same
 * `env`-substitution mechanism {@link withFakeAi} uses (confirmed for `env.AI` by
 * `docs/DECISIONS.md` item 17; `env.DB` is read from the same shared `env` object, so the same
 * substitution reaches `ChatAgent`'s own `this.env.DB`).
 *
 * Used to prove `afterTurnCompleted()`'s D1 writes (recency-touch and auto-titling) are
 * best-effort: a turn must still complete successfully for the client even when both fail
 * (docs/06-AGENTIC-CHAT.md Section 11) -- while the ordinary ownership-checked routes this
 * fixture doesn't target (chat creation, the WebSocket upgrade's own ownership check) keep
 * working normally so the rest of the test can still drive a real turn end to end.
 *
 * @param callback Work to run with the partially-throwing binding installed.
 * @returns Whatever `callback` resolves to.
 */
export async function withThrowingDb<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const original = env.DB;
  (env as unknown as { DB: Pick<D1Database, "prepare"> }).DB = {
    prepare(sql: string) {
      if (sql.includes("chats") && !sql.includes("owner_email")) {
        throw new Error("simulated D1 outage");
      }
      return original.prepare(sql);
    },
  };
  try {
    return await callback();
  } finally {
    (env as unknown as { DB: D1Database }).DB = original;
  }
}
