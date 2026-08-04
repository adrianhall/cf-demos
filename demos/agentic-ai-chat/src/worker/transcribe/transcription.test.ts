import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it } from "vitest";
import { transcribeAudio } from "./transcription";

/** Assert that `promise` rejects with a {@link ProblemDetailsError} shaped as `expected`. */
async function expectProblem(
  promise: Promise<unknown>,
  expected: { detail?: string; status: number },
): Promise<void> {
  try {
    await promise;
    expect.unreachable("expected promise to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as ProblemDetailsError).problemDetails).toMatchObject(
      expected,
    );
  }
}

describe("transcribeAudio", () => {
  it("calls the whisper-large-v3-turbo model with base64-encoded audio and the given gateway id", async () => {
    const calls: { modelId: string; input: unknown; options: unknown }[] = [];
    const ai = {
      run: async (modelId: string, input: unknown, options: unknown) => {
        calls.push({ modelId, input, options });
        return { text: "Hello world" };
      },
      // biome-ignore lint/suspicious/noExplicitAny: matching Ai.run()'s broad overloaded signature for a test fake is not worth reproducing.
    } as any;

    const text = await transcribeAudio(
      ai,
      "my-gateway",
      new Uint8Array([1, 2, 3]),
    );

    expect(text).toBe("Hello world");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      modelId: "@cf/openai/whisper-large-v3-turbo",
      options: { gateway: { id: "my-gateway" } },
    });
    // Bytes [1, 2, 3] base64-encode to "AQID" -- pinning the exact encoding, not just its shape.
    expect(calls[0]?.input).toEqual({ audio: "AQID" });
  });

  it("chunks the base64 conversion so a large audio payload never overflows the call stack", async () => {
    const bytes = new Uint8Array(200_000).fill(7);
    const ai = {
      run: async (_modelId: string, input: { audio: string }) => {
        // Decoding back confirms the chunked conversion round-trips correctly, not just that it
        // ran without throwing.
        const decoded = atob(input.audio);
        expect(decoded).toHaveLength(bytes.length);
        return { text: "ok" };
      },
      // biome-ignore lint/suspicious/noExplicitAny: matching Ai.run()'s broad overloaded signature for a test fake is not worth reproducing.
    } as any;

    await expect(transcribeAudio(ai, "gw", bytes)).resolves.toBe("ok");
  });

  it("maps a thrown Workers AI error to a 502 problem", async () => {
    const ai = {
      run: async () => {
        throw new Error("Rate limited");
      },
      // biome-ignore lint/suspicious/noExplicitAny: matching Ai.run()'s broad overloaded signature for a test fake is not worth reproducing.
    } as any;

    await expectProblem(transcribeAudio(ai, "gw", new Uint8Array([1])), {
      status: 502,
    });
  });

  it("maps an unexpected response shape (no text field) to a 502 problem", async () => {
    const ai = {
      run: async () => ({ transcription_info: { duration: 1 } }),
      // biome-ignore lint/suspicious/noExplicitAny: matching Ai.run()'s broad overloaded signature for a test fake is not worth reproducing.
    } as any;

    await expectProblem(transcribeAudio(ai, "gw", new Uint8Array([1])), {
      detail: "Workers AI returned an unexpected transcription response shape.",
      status: 502,
    });
  });

  it("propagates a ProblemDetailsError thrown by the binding itself unchanged", async () => {
    const original = new ProblemDetailsError({
      status: 503,
      title: "Service unavailable",
    });
    const ai = {
      run: async () => {
        throw original;
      },
      // biome-ignore lint/suspicious/noExplicitAny: matching Ai.run()'s broad overloaded signature for a test fake is not worth reproducing.
    } as any;

    await expect(transcribeAudio(ai, "gw", new Uint8Array([1]))).rejects.toBe(
      original,
    );
  });
});
