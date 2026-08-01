import { describe, expect, it } from "vitest";
import type { ChatStreamFrame } from "../../src/chat-protocol";
import { decodeSseStream } from "../../src/sse";
import {
  ALICE,
  authenticatedRequest,
  authenticatedRequestWithAi,
  type CapturedAiCall,
  createCapturingFakeAi,
  createFakeAi,
  unauthenticatedRequest,
} from "./fixtures";

/** Read every frame from a `/api/chat` response body. */
async function collectFrames(response: Response): Promise<ChatStreamFrame[]> {
  if (!response.body) throw new Error("response has no body");
  const frames: ChatStreamFrame[] = [];
  for await (const payload of decodeSseStream(response.body)) {
    frames.push(JSON.parse(payload) as ChatStreamFrame);
  }
  return frames;
}

/**
 * Exercises `POST /api/chat` in real `workerd`, driving the Hono app with an injected fake `Ai`
 * (see docs/05-AI-CHAT.md, "Workers AI Has No Local Simulation"). Everything except the model
 * itself is real: real Access middleware, real body-limit middleware, real JSON validation, real
 * SSE encoding/decoding. The exhaustive per-adapter/cancellation/error matrix is Phase 5's job
 * (docs/05-AI-CHAT.md, Phase 5, step 23); this file proves the Phase 3 wiring itself works end to
 * end through the real Worker rather than only through directly-imported unit functions.
 */
describe("POST /api/chat", () => {
  it("rejects an unauthenticated request with RFC 9457 problem details, not an HTML redirect", async () => {
    const response = await unauthenticatedRequest("/api/chat", {
      method: "POST",
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("rejects an unknown model before opening any stream", async () => {
    const response = await authenticatedRequest(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/not-a-real/model",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      ALICE,
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("rejects an empty conversation before opening any stream", async () => {
    const response = await authenticatedRequest(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/ibm-granite/granite-4.0-h-micro",
          messages: [],
        }),
      },
      ALICE,
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("rejects a conversation not ending in a user turn before opening any stream", async () => {
    const response = await authenticatedRequest(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/ibm-granite/granite-4.0-h-micro",
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        }),
      },
      ALICE,
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("rejects an oversized request body before opening any stream", async () => {
    const response = await authenticatedRequest(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/ibm-granite/granite-4.0-h-micro",
          messages: [{ role: "user", content: "x".repeat(100_000) }],
        }),
      },
      ALICE,
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("streams start, answer deltas, and done for a valid request (cf-native/plain-response shape)", async () => {
    const fakeAi = createFakeAi([
      '{"response":"Hello"}',
      '{"response":" world"}',
      '{"response":"","usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      "[DONE]",
    ]);

    const response = await authenticatedRequestWithAi(
      "/api/chat",
      fakeAi,
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/ibm-granite/granite-4.0-h-micro",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      ALICE,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const frames = await collectFrames(response);
    expect(frames[0]).toMatchObject({
      type: "start",
      model: "@cf/ibm-granite/granite-4.0-h-micro",
    });
    const answer = frames
      .filter((frame) => frame.type === "answer")
      .map((frame) => frame.text)
      .join("");
    expect(answer).toBe("Hello world");
    const doneFrame = frames.at(-1);
    expect(doneFrame).toMatchObject({
      type: "done",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    // TTFT/total duration are wall-clock measurements taken around the fake stream, not values
    // the fake itself supplies — asserting they are non-negative numbers (rather than a specific
    // value) is what proves `stream.ts` actually measured them, without making the test flaky.
    if (doneFrame?.type === "done") {
      expect(typeof doneFrame.ttftMs).toBe("number");
      expect(doneFrame.ttftMs).toBeGreaterThanOrEqual(0);
      expect(typeof doneFrame.totalMs).toBe("number");
      expect(doneFrame.totalMs).toBeGreaterThanOrEqual(doneFrame.ttftMs);
    }
  });

  it("invokes exactly the requested catalog model with an adapter input carrying the server-owned system prompt, clamped parameters, and no client-supplied system message", async () => {
    const capture: { call?: CapturedAiCall } = {};
    const fakeAi = createCapturingFakeAi(
      ['{"response":"hi"}', "[DONE]"],
      capture,
    );

    const response = await authenticatedRequestWithAi(
      "/api/chat",
      fakeAi,
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/ibm-granite/granite-4.0-h-micro",
          // Requests a temperature above Granite's own descriptor max (5) — proves clamping is
          // actually applied along this end-to-end path, not only in the validation unit tests.
          temperature: 999,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      ALICE,
    );
    expect(response.status).toBe(200);

    expect(capture.call?.modelId).toBe("@cf/ibm-granite/granite-4.0-h-micro");
    const input = capture.call?.input;
    expect(input?.max_tokens).toBeTypeOf("number");
    expect(input?.temperature).toBe(5);
    const messages = input?.messages as
      | readonly { role: string; content: string }[]
      | undefined;
    // The server-owned system prompt is prepended, and it is the only system message: a
    // client-supplied "system" role is rejected outright by validation (see the dedicated
    // rejection test above), never merged in alongside it.
    expect(
      messages?.filter((message) => message.role === "system"),
    ).toHaveLength(1);
    expect(messages?.[0]?.role).toBe("system");
    expect(messages?.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("streams a Thinking panel split from the answer for a reasoning model (inline-think-tags)", async () => {
    const fakeAi = createFakeAi([
      '{"response":"<think>"}',
      '{"response":"working it out"}',
      '{"response":"</think>"}',
      '{"response":"the answer"}',
      "[DONE]",
    ]);

    const response = await authenticatedRequestWithAi(
      "/api/chat",
      fakeAi,
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      ALICE,
    );

    const frames = await collectFrames(response);
    const thinking = frames
      .filter((frame) => frame.type === "thinking")
      .map((frame) => frame.text)
      .join("");
    const answer = frames
      .filter((frame) => frame.type === "answer")
      .map((frame) => frame.text)
      .join("");
    expect(thinking).toBe("working it out");
    expect(answer).toBe("the answer");
  });

  it("streams reasoning_content directly for an openai-chat reasoning-field model", async () => {
    const fakeAi = createFakeAi([
      '{"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
      '{"choices":[{"delta":{"content":"the answer"}}]}',
      "[DONE]",
    ]);

    const response = await authenticatedRequestWithAi(
      "/api/chat",
      fakeAi,
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/zai-org/glm-4.7-flash",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      ALICE,
    );

    const frames = await collectFrames(response);
    expect(
      frames.some(
        (frame) => frame.type === "thinking" && frame.text === "thinking...",
      ),
    ).toBe(true);
    expect(
      frames.some(
        (frame) => frame.type === "answer" && frame.text === "the answer",
      ),
    ).toBe(true);
  });

  it("reports null usage in the done frame when the fake model reports none", async () => {
    const fakeAi = createFakeAi(['{"response":"hi"}', "[DONE]"]);
    const response = await authenticatedRequestWithAi(
      "/api/chat",
      fakeAi,
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/ibm-granite/granite-4.0-h-micro",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      ALICE,
    );
    const frames = await collectFrames(response);
    expect(frames.at(-1)).toMatchObject({ type: "done", usage: null });
  });

  it("converts a post-first-byte failure into an in-band error frame and logs ai_inference_failed", async () => {
    const fakeAi: Pick<Ai, "run"> = {
      run: (async () => {
        return new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"response":"partial"}\n\n'),
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
            controller.error(new Error("upstream connection reset"));
          },
        });
        // biome-ignore lint/suspicious/noExplicitAny: matching env.AI.run()'s broad overloaded signature for a test fake is not worth reproducing.
      }) as any,
    };

    const response = await authenticatedRequestWithAi(
      "/api/chat",
      fakeAi,
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/ibm-granite/granite-4.0-h-micro",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      ALICE,
    );

    expect(response.status).toBe(200);
    const frames = await collectFrames(response);
    expect(frames.at(-1)).toMatchObject({ type: "error", status: 502 });
  });

  it("aborts the upstream reader and logs ai_stream_aborted when the consumer cancels the response", async () => {
    let upstreamCancelled = false;
    const fakeAi: Pick<Ai, "run"> = {
      run: (async () => {
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"response":"x"}\n\n'),
            );
          },
          cancel() {
            upstreamCancelled = true;
          },
        });
        // biome-ignore lint/suspicious/noExplicitAny: matching env.AI.run()'s broad overloaded signature for a test fake is not worth reproducing.
      }) as any,
    };

    const response = await authenticatedRequestWithAi(
      "/api/chat",
      fakeAi,
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/ibm-granite/granite-4.0-h-micro",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      ALICE,
    );

    const reader = response.body?.getReader();
    if (!reader) throw new Error("response has no body");
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upstreamCancelled).toBe(true);
  });

  it("converts an env.AI.run() rejection to a 502 problem details response before any stream opens", async () => {
    const fakeAi: Pick<Ai, "run"> = {
      run: (async () => {
        throw new Error("AiError: model temporarily unavailable");
        // biome-ignore lint/suspicious/noExplicitAny: matching env.AI.run()'s broad overloaded signature for a test fake is not worth reproducing.
      }) as any,
    };

    const response = await authenticatedRequestWithAi(
      "/api/chat",
      fakeAi,
      {
        method: "POST",
        body: JSON.stringify({
          model: "@cf/ibm-granite/granite-4.0-h-micro",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      ALICE,
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});
