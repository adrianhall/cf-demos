import { exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { describe, expect, it } from "vitest";

/**
 * Phase 2 smoke tests confirm the Worker boots against the generated `wrangler.jsonc`
 * (including its `DB` D1 binding) and rejects unauthenticated API traffic before routing.
 *
 * Phase 3 replaces the authenticated 404 assertion with the `/api/todos` workflow and
 * per-user isolation coverage.
 */
describe("Tasks Worker", () => {
  it("rejects an unauthenticated API request", async () => {
    const response = await exports.default.fetch(
      new Request("https://tasks.example/api/todos"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("uses a verified Access identity before an unrouted API request falls through", async () => {
    const token = await signDevJwt("alice@example.com");
    const response = await exports.default.fetch(
      new Request("https://tasks.example/api/todos", {
        headers: { [JWT_HEADER]: token },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});
