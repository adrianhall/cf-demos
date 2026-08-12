import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppBindings } from "../bindings";
import { meRouter } from "./me";

/** Build a standalone test app mounting only `meRouter`, with a middleware stand-in for
 * `accessMiddleware` that sets `Cloudflare_Access_Identity` directly -- this route's own
 * behavior (Implementation Plan Phase 5, item 23) never depends on the real `cloudflareAccess()`
 * middleware's JWT verification, only on the context variable it sets. */
function buildApp(
  identity: { email: string; sub: string; source: "header" } | null,
) {
  const app = new Hono<AppBindings>();
  app.use(async (context, next) => {
    if (identity !== null) {
      context.set("Cloudflare_Access_Identity", identity);
    }
    await next();
  });
  app.route("/api/me", meRouter);
  return app;
}

describe("GET /api/me", () => {
  it("returns the verified identity's email", async () => {
    const app = buildApp({
      email: "reviewer@example.com",
      sub: "user-123",
      source: "header",
    });

    const response = await app.request("/api/me");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "reviewer@example.com" });
  });

  it("throws a defensive guard error when no identity was set (accessMiddleware did not run)", async () => {
    const app = buildApp(null);

    const response = await app.request("/api/me");

    // `throwIfNull()` raises a `NullError` (a `ProblemDetailsError`), which even without this
    // test app mounting `problemDetailsErrorHandler()` still surfaces as a problem+json 500 --
    // `ProblemDetailsError.getResponse()` builds a standalone response, per its own doc comment.
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});
