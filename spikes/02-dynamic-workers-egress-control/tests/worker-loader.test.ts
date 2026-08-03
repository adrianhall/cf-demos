/**
 * @file Answers Spike C's other explicitly stated testability question
 * (docs/06-AGENTIC-CHAT.md Section 8, Phase 0 Spike C): "whether
 * `@cloudflare/vitest-pool-workers` supports `worker_loaders` locally for integration tests."
 * This test drives the real chain — the Worker's own `fetch()` handler obtaining
 * `ctx.exports.EgressGateway({})`, passing it into the real `ToolRunner` Durable Object, which
 * calls the real `env.LOADER.get()` to load and run a real Dynamic Worker — entirely inside
 * `@cloudflare/vitest-pool-workers`' real `workerd` instance.
 *
 * It deliberately requests a **non-allow-listed** host so the `EgressGateway` blocks the request
 * before any real network `fetch()` happens (Spike C's aim: "a real network fetch inside a test
 * is undesirable regardless"). The allow-listed, real-network-fetching path is live-verified
 * once, manually, over `wrangler dev` — see `README.md`/`REPORT.md` — rather than repeated here.
 */
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker_loaders under @cloudflare/vitest-pool-workers", () => {
  it("loads and runs a Dynamic Worker from inside a Durable Object, gateway blocking a non-allow-listed host", async () => {
    const response = await exports.default.fetch(
      new Request("https://spike.example/?url=https://not-allow-listed.example/"),
    );

    expect(response.status).toBe(200); // the spike Worker's own response, not the tool's
    const result = (await response.json()) as {
      ctxExportsAvailableInsideDurableObject: boolean;
      status: number;
      body: string;
    };

    expect(result).toMatchObject({
      ctxExportsAvailableInsideDurableObject: true,
      status: 403,
    });
    expect(result.body).toContain("not-allow-listed.example");
  });

  it("rejects a request with no ?url= before ever touching the Durable Object or LOADER", async () => {
    const response = await exports.default.fetch(new Request("https://spike.example/"));
    expect(response.status).toBe(400);
  });
});
