import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * Phase 1 scaffold smoke test: confirms the Worker boots against the generated
 * `wrangler.jsonc` (including its `DB` D1 binding) and produces the toolkit's RFC 9457
 * `application/problem+json` shape for an unrouted request.
 *
 * Phase 3 replaces this with the full `/api/todos` workflow and per-user isolation coverage;
 * Phase 2 adds Cloudflare Access enforcement assertions once `cloudflareAccess()` is wired in.
 */
describe("Tasks Worker", () => {
  it("returns a problem-details 404 for an unrouted /api request", async () => {
    const response = await exports.default.fetch(
      new Request("https://tasks.example/api/todos"),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});
