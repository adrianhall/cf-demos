import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import worker from "../../src/worker/index";

/** Verified identity used by default when a test does not care which participant acts. */
export const ALICE = "alice@example.com";

/** A second verified identity, used wherever a test must prove behavior is identity-agnostic. */
export const BOB = "bob@example.com";

/**
 * Send one request through the real Worker as a verified Cloudflare Access identity.
 *
 * Integration tests import the Hono app directly and drive it with `app.fetch()` rather than
 * `SELF.fetch()` (see docs/05-AI-CHAT.md, "Workers AI Has No Local Simulation") so a later phase
 * can substitute a fake `Ai` implementation into `env` at the same call site.
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
  const request = new Request(`https://ai-chat.example${path}`, {
    ...init,
    headers,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
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
  const request = new Request(`https://ai-chat.example${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Send one authenticated request with `env.AI` substituted for a fake implementation.
 *
 * `tests/integration/vitest.config.ts` sets `remoteBindings: false`, so the real `AI` binding in
 * `env` exists but is non-functional (see docs/05-AI-CHAT.md, "Workers AI Has No Local
 * Simulation") — every `/api/chat` integration test drives the Worker through this helper instead
 * of `authenticatedRequest`, so the real Access middleware, body-limit middleware, JSON parsing,
 * and SSE response construction all run in real `workerd`, with only the model itself faked.
 *
 * @param path Request path beginning with `/`.
 * @param fakeAi A minimal `Ai`-shaped fake; only `run()` needs to be implemented (see
 * {@link createFakeAi}).
 * @param init Ordinary `fetch` request options.
 * @param email Verified identity to sign a development Access token for.
 * @returns The Worker's response.
 */
export async function authenticatedRequestWithAi(
  path: string,
  fakeAi: Pick<Ai, "run">,
  init: RequestInit = {},
  email: string = ALICE,
): Promise<Response> {
  const token = await signDevJwt(email);
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, token);
  const request = new Request(`https://ai-chat.example${path}`, {
    ...init,
    headers,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    request,
    { ...env, AI: fakeAi as Ai },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Build a minimal fake `Ai` binding whose `run()` always resolves to a `ReadableStream` of raw
 * SSE bytes built from `payloads` — exactly the shape `env.AI.run(..., { stream: true })` itself
 * resolves to (see docs/05-AI-CHAT.md, "Streaming Protocol"), so the real `src/sse.ts` decoder is
 * exercised end to end rather than bypassed.
 *
 * @param payloads Raw `data:` payload strings (JSON chunk text or the literal `"[DONE]"`), in
 * the order they should be streamed.
 * @returns A fake `Ai`-shaped object suitable for {@link authenticatedRequestWithAi}.
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
