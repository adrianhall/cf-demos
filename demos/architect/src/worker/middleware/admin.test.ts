import type { CloudflareAccessIdentity } from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppBindings } from "../bindings";
import { requireAdmin } from "./admin";

/** Build a test app that sets a verified identity ahead of the middleware under test. */
function buildApp(identity: CloudflareAccessIdentity) {
  const app = new Hono<AppBindings>();
  app.use(async (context, next) => {
    context.set("Cloudflare_Access_Identity", identity);
    await next();
  });
  app.use(requireAdmin);
  app.get("/", (context) => context.text("ok"));
  return app;
}

describe("requireAdmin", () => {
  it("allows the identity matching ADMIN_EMAIL through", async () => {
    const app = buildApp({
      email: "admin@example.com",
      source: "header",
      sub: "sub-admin",
    });

    const response = await app.request(
      "/",
      {},
      { ADMIN_EMAIL: "admin@example.com" },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("rejects any other verified identity with 403", async () => {
    const app = buildApp({
      email: "alice@example.com",
      source: "header",
      sub: "sub-alice",
    });

    const response = await app.request(
      "/",
      {},
      { ADMIN_EMAIL: "admin@example.com" },
    );

    expect(response.status).toBe(403);
  });

  it("throws when no identity was verified ahead of this middleware", async () => {
    const app = new Hono<AppBindings>();
    app.use(requireAdmin);
    app.get("/", (context) => context.text("ok"));

    const response = await app.request(
      "/",
      {},
      { ADMIN_EMAIL: "admin@example.com" },
    );

    expect(response.status).toBe(500);
  });
});
