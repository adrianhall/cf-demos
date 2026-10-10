/**
 * @file Unit-style tests for `EgressGateway` (docs/06-AGENTIC-CHAT.md Phase 10, US-9). Colocated
 * here rather than as `src/worker/egress/gateway.test.ts` because `EgressGateway` imports
 * `cloudflare:workers` (`WorkerEntrypoint`) at module scope -- the same reason `ChatAgent` has no
 * colocated unit test either (`EXPLAIN-DEMO.md`'s "Testing this phase without a real model
 * call"): the plain-Node `worker` Vitest project cannot resolve that import at all. This mirrors
 * Spike C's own `egress-gateway.test.ts`, adapted to this demo's real allow-list and
 * `EgressGatewayProps` shape, and asserts allow/block decisions with **zero** real network
 * traffic (per Spike C's confirmed "inject a fake fetch" testability finding).
 */
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_HOSTS } from "../../src/worker/egress/allowlist";
import { EgressGateway, networkFetch } from "../../src/worker/egress/gateway";

const [allowedHost] = ALLOWED_HOSTS;
const originalImpl = networkFetch.impl;

describe("EgressGateway (unit, no real network access)", () => {
  afterEach(() => {
    networkFetch.impl = originalImpl;
  });

  it("forwards to the injected fetch for an allow-listed host", async () => {
    const fakeFetch = vi.fn(
      async () => new Response("fake body", { status: 200 }),
    );
    networkFetch.impl = fakeFetch;

    const ctx = createExecutionContext();
    // biome-ignore lint/suspicious/noExplicitAny: EgressGatewayProps isn't part of the plain ExecutionContext createExecutionContext() returns.
    (ctx as any).props = { chatId: "chat-1" };
    const gateway = new EgressGateway(ctx, env);
    const response = await gateway.fetch(
      new Request(`https://${allowedHost}/`),
    );

    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fake body");
  });

  it("blocks a non-allow-listed host without ever calling the injected fetch", async () => {
    const fakeFetch = vi.fn();
    networkFetch.impl = fakeFetch;

    const gateway = new EgressGateway(createExecutionContext(), env);
    const response = await gateway.fetch(
      new Request("https://not-allow-listed.example/"),
    );

    expect(fakeFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("not-allow-listed.example");
  });

  it("does not throw when constructed with no props at all", async () => {
    // `ctx.exports.EgressGateway()`'s own options are `{ props?: Props }` -- `props` is
    // optional at the call site even though `EgressGatewayProps` itself has no optional fields,
    // so the gateway's own logging must tolerate a genuinely absent `props` (Section 11's
    // general "never let bookkeeping crash the actual operation" principle, applied here to
    // logging rather than a D1 write).
    const fakeFetch = vi.fn(async () => new Response("ok"));
    networkFetch.impl = fakeFetch;

    const gateway = new EgressGateway(createExecutionContext(), env);
    const response = await gateway.fetch(
      new Request(`https://${allowedHost}/`),
    );

    expect(response.status).toBe(200);
  });
});
