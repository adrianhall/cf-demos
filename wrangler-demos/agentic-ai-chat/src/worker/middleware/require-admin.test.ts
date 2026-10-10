import { problemDetailsErrorHandler } from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppBindings } from "../bindings";
import { requireAdmin } from "./require-admin";

/** Build a minimal fake D1 whose `first()` always resolves `userRow` -- enough to exercise
 * `UserRepository.isAdmin()`'s single read, mirroring `./transcribe-body-limit.test.ts`'s "wire
 * the real error handler, assert on real HTTP" pattern. */
function fakeDatabase(
  userRow: Record<string, unknown> | null,
): Pick<D1Database, "prepare"> {
  return {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        first: async () => userRow,
      };
      return statement as unknown as D1PreparedStatement;
    },
  };
}

/**
 * Build a minimal Hono app with a fake verified identity installed ahead of `requireAdmin`, so
 * assertions can check real HTTP status instead of reaching into the middleware's internals.
 *
 * @param email The identity `requireAdmin` should see as already verified.
 */
function buildApp(email: string): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use(async (context, next) => {
    context.set("Cloudflare_Access_Identity", {
      email,
      source: "header",
      sub: "test-sub",
    });
    await next();
  });
  app.use(requireAdmin);
  app.get("/", (context) => context.json({ ok: true }));
  app.onError(problemDetailsErrorHandler());
  return app;
}

describe("requireAdmin", () => {
  it("allows an administrator identity through", async () => {
    const response = await buildApp("admin@example.com").request("/", {}, {
      DB: fakeDatabase({
        business: null,
        created_at: "2026-08-03T00:00:00.000Z",
        email: "admin@example.com",
        geo: null,
        is_admin: 1,
      }),
    } as unknown as Env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects a signed-in, non-administrator identity with 403", async () => {
    const response = await buildApp("alice@example.com").request("/", {}, {
      DB: fakeDatabase({
        business: null,
        created_at: "2026-08-03T00:00:00.000Z",
        email: "alice@example.com",
        geo: null,
        is_admin: 0,
      }),
    } as unknown as Env);

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      detail: "This route requires this demo's administrator role.",
    });
  });

  it("rejects an identity that has never signed in (no users row at all) with 403, not a throw", async () => {
    const response = await buildApp("never-signed-in@example.com").request(
      "/",
      {},
      { DB: fakeDatabase(null) } as unknown as Env,
    );

    expect(response.status).toBe(403);
  });
});
