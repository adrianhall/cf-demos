import { problemDetailsErrorHandler } from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestBodyLimit } from "./body-limit";

const MAX_BYTES = 512 * 1_024;

/**
 * Build a minimal Hono app wiring `requestBodyLimit` in front of a trivial route, plus the same
 * `problemDetailsErrorHandler` `../index.ts` wires, matching `demos/url-shortener`'s equivalent
 * test.
 */
function buildApp(): Hono {
  const app = new Hono();
  app.use(requestBodyLimit);
  app.post("/", async (context) => context.json({ ok: true }));
  app.onError(problemDetailsErrorHandler());
  return app;
}

describe("requestBodyLimit", () => {
  it("allows a body within the 512 KB limit", async () => {
    const response = await buildApp().request("/", {
      body: JSON.stringify({ graphData: "{}" }),
      method: "POST",
    });
    expect(response.status).toBe(200);
  });

  it("rejects a body over the 512 KB limit (Content-Length path)", async () => {
    const response = await buildApp().request("/", {
      body: "x".repeat(MAX_BYTES + 1),
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      detail: "Request body exceeds the 512 KB limit.",
    });
  });

  it("rejects an oversized chunked body with no Content-Length (streamed fallback path)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(MAX_BYTES + 1)));
        controller.close();
      },
    });

    const response = await buildApp().request("/", {
      body: stream,
      method: "POST",
      // `duplex` is required by the Fetch spec for streamed request bodies but is missing from
      // the DOM `RequestInit` type this project targets.
      // @ts-expect-error -- see above.
      duplex: "half",
    });

    expect(response.status).toBe(400);
  });

  it("allows a request with no body at all", async () => {
    const response = await buildApp().request("/", { method: "POST" });
    expect(response.status).toBe(200);
  });
});
