import { describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  createFakeTranscribeAi,
  unauthenticatedRequest,
  withFakeAi,
} from "./fixtures";

/** A small, arbitrary non-empty audio payload -- its content is irrelevant since every test
 * here substitutes a fake `env.AI` binding; only its byte length and Content-Type matter. */
const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

/** A fake `Ai` binding that records every call it receives into `calls`, so a validation-
 * rejection test can assert Workers AI was never reached at all. */
function createTrackingFakeAi(calls: unknown[]): Pick<Ai, "run"> {
  return {
    run: (async (...args: unknown[]) => {
      calls.push(args);
      return { text: "should never be reached" };
      // biome-ignore lint/suspicious/noExplicitAny: matching Ai.run()'s broad overloaded signature for a test fake is not worth reproducing.
    }) as any,
  };
}

/**
 * Exercises Phase 5's voice-to-prompt dictation endpoint (US-4, docs/06-AGENTIC-CHAT.md):
 * `POST /api/transcribe` requires an authenticated Access identity like every other `/api/*`
 * route, accepts a scripted transcription through a fake `env.AI` binding (never a real,
 * billable Workers AI call, per this checkout's established testing convention), and rejects an
 * oversized or wrongly-typed payload before any model call.
 */
describe("Voice-to-prompt dictation (US-4)", () => {
  it("transcribes a scripted fixture through a fake AI binding", async () => {
    const response = await withFakeAi(
      createFakeTranscribeAi("What is the capital of France?"),
      () =>
        authenticatedRequest("/api/transcribe", {
          method: "POST",
          headers: { "content-type": "audio/webm;codecs=opus" },
          body: AUDIO_BYTES,
        }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "What is the capital of France?",
    });
  });

  it("rejects an unauthenticated request", async () => {
    const response = await unauthenticatedRequest("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: AUDIO_BYTES,
    });

    expect(response.status).toBe(401);
  });

  it("rejects an oversized payload before any model call", async () => {
    const calls: unknown[] = [];
    const response = await withFakeAi(createTrackingFakeAi(calls), () =>
      authenticatedRequest("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        // One byte over `MAX_AUDIO_BYTES` (8 MiB) -- see src/worker/transcribe/validation.ts.
        body: new Uint8Array(8 * 1024 * 1024 + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects a request with no Content-Type header at all before any model call", async () => {
    const calls: unknown[] = [];
    const response = await withFakeAi(createTrackingFakeAi(calls), () =>
      authenticatedRequest("/api/transcribe", {
        method: "POST",
        body: AUDIO_BYTES,
      }),
    );

    expect(response.status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-audio content type before any model call", async () => {
    const calls: unknown[] = [];
    const response = await withFakeAi(createTrackingFakeAi(calls), () =>
      authenticatedRequest("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: AUDIO_BYTES,
      }),
    );

    expect(response.status).toBe(415);
    expect(calls).toHaveLength(0);
  });
});
