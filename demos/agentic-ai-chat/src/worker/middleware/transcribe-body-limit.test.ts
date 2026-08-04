import { problemDetailsErrorHandler } from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MAX_AUDIO_BYTES } from "../transcribe/validation";
import { transcribeRequestBodyLimit } from "./transcribe-body-limit";

/**
 * Build a minimal Hono app wiring `transcribeRequestBodyLimit` in front of a trivial route,
 * plus the same `problemDetailsErrorHandler` `../index.ts` wires, so assertions can check real
 * HTTP status/body instead of reaching into `onError`'s internals.
 */
function buildApp(): Hono {
  const app = new Hono();
  app.use(transcribeRequestBodyLimit);
  app.post("/", async (context) => context.json({ ok: true }));
  app.onError(problemDetailsErrorHandler());
  return app;
}

describe("transcribeRequestBodyLimit", () => {
  it("allows a body within the limit", async () => {
    const response = await buildApp().request("/", {
      body: new Uint8Array(1_024),
      method: "POST",
    });
    expect(response.status).toBe(200);
  });

  it("rejects a body over the limit with a 413 (Content-Length path)", async () => {
    const response = await buildApp().request("/", {
      body: new Uint8Array(MAX_AUDIO_BYTES + 1),
      method: "POST",
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      detail: `Request body exceeds the ${MAX_AUDIO_BYTES} byte limit.`,
    });
  });

  it("rejects an oversized chunked body with no Content-Length (streamed fallback path)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES + 1));
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

    expect(response.status).toBe(413);
  });

  it("allows a request with no body at all", async () => {
    const response = await buildApp().request("/", { method: "POST" });
    expect(response.status).toBe(200);
  });
});
