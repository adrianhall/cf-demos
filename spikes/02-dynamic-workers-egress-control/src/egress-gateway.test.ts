/**
 * @file Answers one of Spike C's explicitly stated open questions (docs/06-AGENTIC-CHAT.md
 * Section 8, Phase 0 Spike C): "confirm whether the gateway itself, independent of `fetch()`, is
 * unit-testable by injecting a fake `fetch` into the `EgressGateway` class." Per Section 8's "do
 * not write tests for a spike unless the test is what runs the spike," this file *is* how that
 * question gets answered — not a redundant mock-based re-confirmation of the live-verified
 * allow/block behavior in `README.md`/`REPORT.md` (which was proved end to end with a real
 * network call to a real allow-listed host over `wrangler dev`, deliberately not repeated here).
 */
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_HOSTS, EgressGateway, networkFetch } from "./egress-gateway";

const [allowedHost] = ALLOWED_HOSTS;
const originalImpl = networkFetch.impl;

describe("EgressGateway (unit, no real network access)", () => {
  afterEach(() => {
    networkFetch.impl = originalImpl;
  });

  it("forwards to the injected fetch for an allow-listed host", async () => {
    const fakeFetch = vi.fn(async () => new Response("fake body", { status: 200 }));
    networkFetch.impl = fakeFetch;

    const gateway = new EgressGateway(createExecutionContext(), env);
    const response = await gateway.fetch(new Request(`https://${allowedHost}/`));

    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fake body");
  });

  it("blocks a non-allow-listed host without ever calling the injected fetch", async () => {
    const fakeFetch = vi.fn();
    networkFetch.impl = fakeFetch;

    const gateway = new EgressGateway(createExecutionContext(), env);
    const response = await gateway.fetch(new Request("https://not-allow-listed.example/"));

    expect(fakeFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("not-allow-listed.example");
  });
});
