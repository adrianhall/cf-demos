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
