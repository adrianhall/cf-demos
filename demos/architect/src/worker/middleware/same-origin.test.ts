import { problemDetailsErrorHandler } from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { enforceSameOriginJson } from "./same-origin";

/**
 * Build a minimal Hono app wiring `enforceSameOriginJson` in front of trivial routes for every
 * mutating verb, plus the same `problemDetailsErrorHandler` `../index.ts` wires, so assertions
 * can check real HTTP status/body instead of reaching into `onError`'s internals. Hono's
 * `app.request()` test helper resolves a relative path against `http://localhost`, so that is
 * this app's "own origin" for every test below.
 */
function buildApp(): Hono {
  const app = new Hono();
  app.use(enforceSameOriginJson);
  app.post("/", async (context) => context.json({ ok: true }));
  app.put("/", async (context) => context.json({ ok: true }));
  app.patch("/", async (context) => context.json({ ok: true }));
  app.delete("/", async (context) => context.json({ ok: true }));
  app.onError(problemDetailsErrorHandler());
  return app;
}

describe("enforceSameOriginJson", () => {
  it("allows a same-origin POST with a matching Origin header and JSON content type", async () => {
    const response = await buildApp().request("/", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
  });

  it("allows a same-origin POST identified only by Sec-Fetch-Site, with no Origin header", async () => {
    const response = await buildApp().request("/", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
  });

  it("allows a JSON content type with a charset suffix", async () => {
    const response = await buildApp().request("/", {
      body: "{}",
      headers: {
        "content-type": "application/json; charset=utf-8",
        origin: "http://localhost",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
  });

  it("rejects a request with no Origin and no Sec-Fetch-Site header at all", async () => {
    const response = await buildApp().request("/", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("rejects a foreign Origin header", async () => {
    const response = await buildApp().request("/", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      method: "POST",
    });
    expect(response.status).toBe(403);
  });

  it("rejects Sec-Fetch-Site: cross-site even when Origin happens to match", async () => {
    const response = await buildApp().request("/", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        "sec-fetch-site": "cross-site",
      },
      method: "POST",
    });
    expect(response.status).toBe(403);
  });

  it("rejects a same-origin POST with a non-JSON content type", async () => {
    const response = await buildApp().request("/", {
      body: "plain text",
      headers: { "content-type": "text/plain", origin: "http://localhost" },
      method: "POST",
    });
    expect(response.status).toBe(415);
  });

  it("rejects a same-origin POST with no content type at all", async () => {
    const response = await buildApp().request("/", {
      body: "{}",
      headers: { origin: "http://localhost" },
      method: "POST",
    });
    expect(response.status).toBe(415);
  });

  it.each(["PUT", "PATCH"] as const)(
    "applies the same checks to %s",
    async (method) => {
      const response = await buildApp().request("/", {
        headers: { origin: "http://localhost" },
        method,
      });
      expect(response.status).toBe(415);
    },
  );

  it("does not require a JSON content type for DELETE, which carries no body", async () => {
    const response = await buildApp().request("/", {
      headers: { origin: "http://localhost" },
      method: "DELETE",
    });
    expect(response.status).toBe(200);
  });

  it("still enforces the same-origin check for DELETE", async () => {
    const response = await buildApp().request("/", {
      headers: { origin: "https://evil.example" },
      method: "DELETE",
    });
    expect(response.status).toBe(403);
  });
});
