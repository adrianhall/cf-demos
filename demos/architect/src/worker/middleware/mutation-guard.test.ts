import { problemDetailsErrorHandler } from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireSameOriginMutation } from "./mutation-guard";

function buildApp(): Hono {
  const app = new Hono();
  app.use(requireSameOriginMutation);
  app.get("/", (context) => context.json({ ok: true }));
  app.post("/", (context) => context.json({ ok: true }));
  app.onError(problemDetailsErrorHandler());
  return app;
}

describe("requireSameOriginMutation", () => {
  it("allows a GET request with no Origin header", async () => {
    const app = buildApp();
    const response = await app.request("https://demo.test/");
    expect(response.status).toBe(200);
  });

  it("rejects a POST request with a missing Origin header", async () => {
    const app = buildApp();
    const response = await app.request("https://demo.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a POST request with a foreign Origin", async () => {
    const app = buildApp();
    const response = await app.request("https://demo.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.test",
      },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a same-origin POST without a JSON content type", async () => {
    const app = buildApp();
    const response = await app.request("https://demo.test/", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://demo.test",
      },
    });
    expect(response.status).toBe(415);
  });

  it("allows a same-origin JSON POST", async () => {
    const app = buildApp();
    const response = await app.request("https://demo.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://demo.test",
      },
    });
    expect(response.status).toBe(200);
  });
});
