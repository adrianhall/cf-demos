import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it } from "vitest";
import {
  MAX_AUDIO_BYTES,
  validateAudioBytes,
  validateContentType,
} from "./validation";

/** Assert that `fn` throws a {@link ProblemDetailsError} shaped as `expected`. */
function expectProblem(
  fn: () => unknown,
  expected: { detail?: string; status: number },
): void {
  try {
    fn();
    expect.unreachable("expected fn to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as ProblemDetailsError).problemDetails).toMatchObject(
      expected,
    );
  }
}

describe("validateContentType", () => {
  it("accepts an audio/webm content type, the browser MediaRecorder default", () => {
    expect(validateContentType("audio/webm;codecs=opus")).toBe("audio/webm");
  });

  it("accepts audio/ogg, Firefox's MediaRecorder default", () => {
    expect(validateContentType("audio/ogg;codecs=opus")).toBe("audio/ogg");
  });

  it("normalizes case and strips whitespace", () => {
    expect(validateContentType(" Audio/Webm ")).toBe("audio/webm");
  });

  it("rejects a missing Content-Type header", () => {
    expectProblem(() => validateContentType(null), {
      detail:
        "Content-Type must be an audio MIME type, for example audio/webm.",
      status: 415,
    });
  });

  it("rejects a non-audio content type", () => {
    expectProblem(() => validateContentType("application/json"), {
      status: 415,
    });
    expectProblem(() => validateContentType("text/plain"), { status: 415 });
    expectProblem(() => validateContentType("video/webm"), { status: 415 });
  });
});

describe("validateAudioBytes", () => {
  it("returns non-empty bytes within the limit unchanged", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(validateAudioBytes(bytes)).toBe(bytes);
  });

  it("rejects an empty body", () => {
    expectProblem(() => validateAudioBytes(new Uint8Array(0)), {
      detail: "The request body must contain audio data.",
      status: 422,
    });
  });

  it("rejects a body over MAX_AUDIO_BYTES", () => {
    expectProblem(
      () => validateAudioBytes(new Uint8Array(MAX_AUDIO_BYTES + 1)),
      {
        detail: `Audio must not exceed ${MAX_AUDIO_BYTES} bytes.`,
        status: 413,
      },
    );
  });

  it("accepts a body exactly at MAX_AUDIO_BYTES", () => {
    const bytes = new Uint8Array(MAX_AUDIO_BYTES);
    expect(validateAudioBytes(bytes)).toBe(bytes);
  });
});
