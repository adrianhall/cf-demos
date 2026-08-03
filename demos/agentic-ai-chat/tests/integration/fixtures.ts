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

/** What {@link createCapturingFakeAi} recorded about the one call it received. */
export interface CapturedAiCall {
  /** The exact model ID string `env.AI.run()` was called with. */
  readonly modelId: string;
  /** The exact input object `workers-ai-provider` built, before any streaming/parsing. */
  readonly input: Record<string, unknown>;
}

/**
 * Build a fake `Ai` binding identical to {@link createFakeAi}, but that also records the model
 * ID and input object it was actually called with into `capture` -- used to prove `ChatAgent`'s
 * system prompt actually carries the identity `onStart()` captured, something only an
 * end-to-end request through the real Worker and Durable Object can prove.
 *
 * @param payloads Raw `data:` payload strings streamed back, exactly as {@link createFakeAi}.
 * @param capture A mutable single-element holder the fake writes its one observed call into.
 * @returns A fake `Ai`-shaped object suitable for {@link withFakeAi}.
 */
export function createCapturingFakeAi(
  payloads: readonly string[],
  capture: { call?: CapturedAiCall },
): Pick<Ai, "run"> {
  return {
    run: ((modelId: string, input: Record<string, unknown>) => {
      capture.call = { modelId, input };
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
