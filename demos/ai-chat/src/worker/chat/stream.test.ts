import { describe, expect, it, vi } from "vitest";
import type { ChatStreamFrame } from "../../chat-protocol";
import { findModel } from "../../models";
import { decodeSseStream } from "../../sse";
import { buildChatStreamResponse } from "./stream";

const GRANITE = findModel("@cf/ibm-granite/granite-4.0-h-micro");
if (!GRANITE)
  throw new Error("test setup: Granite descriptor missing from catalog");

/** Build a fake upstream SSE byte stream from raw `data:` payload strings. */
function upstreamSseStream(
  payloads: readonly string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = payloads.map((payload) => `data: ${payload}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Read every frame from a chat stream `Response` body. */
async function collectFrames(response: Response): Promise<ChatStreamFrame[]> {
  if (!response.body) throw new Error("response has no body");
  const frames: ChatStreamFrame[] = [];
  for await (const payload of decodeSseStream(response.body)) {
    frames.push(JSON.parse(payload) as ChatStreamFrame);
  }
  return frames;
}

describe("buildChatStreamResponse", () => {
  it("sets the streaming response headers", () => {
    const response = buildChatStreamResponse(
      GRANITE.id,
      "req-1",
      GRANITE,
      upstreamSseStream(["[DONE]"]),
    );
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("writes start, then deltas, then done, in order", async () => {
    const upstream = upstreamSseStream([
      '{"choices":[{"delta":{"content":"Hello"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '{"response":"","usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}',
      "[DONE]",
    ]);

    const response = buildChatStreamResponse(
      GRANITE.id,
      "req-1",
      GRANITE,
      upstream,
    );
    const frames = await collectFrames(response);

    expect(frames[0]).toEqual({
      type: "start",
      model: GRANITE.id,
      requestId: "req-1",
    });
    expect(
      frames.some((frame) => frame.type === "answer" && frame.text === "Hello"),
    ).toBe(true);
    const done = frames.at(-1);
    expect(done).toMatchObject({
      type: "done",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
    });
  });

  it("reports null usage in the done frame when the model reported none", async () => {
    const upstream = upstreamSseStream([
      '{"choices":[{"delta":{"content":"hi"}}]}',
      "[DONE]",
    ]);
    const response = buildChatStreamResponse(
      GRANITE.id,
      "req-1",
      GRANITE,
      upstream,
    );
    const frames = await collectFrames(response);
    expect(frames.at(-1)).toMatchObject({ type: "done", usage: null });
  });

  it("calls onFirstToken exactly once, at the first delta", async () => {
    const onFirstToken = vi.fn();
    const upstream = upstreamSseStream([
      '{"choices":[{"delta":{"content":"a"}}]}',
      '{"choices":[{"delta":{"content":"b"}}]}',
      "[DONE]",
    ]);
    const response = buildChatStreamResponse(
      GRANITE.id,
      "req-1",
      GRANITE,
      upstream,
      {
        callbacks: { onFirstToken },
      },
    );
    await collectFrames(response);
    expect(onFirstToken).toHaveBeenCalledTimes(1);
    expect(onFirstToken).toHaveBeenCalledWith(expect.any(Number));
  });

  it("calls onDone with ttftMs, totalMs, usage, and finishReason", async () => {
    const onDone = vi.fn();
    const upstream = upstreamSseStream([
      '{"choices":[{"delta":{"content":"hi"}},{}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "[DONE]",
    ]);
    const response = buildChatStreamResponse(
      GRANITE.id,
      "req-1",
      GRANITE,
      upstream,
      {
        callbacks: { onDone },
      },
    );
    await collectFrames(response);
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        ttftMs: expect.any(Number),
        totalMs: expect.any(Number),
        finishReason: "stop",
      }),
    );
  });

  it("converts a post-first-byte failure into an error frame and calls onFailed", async () => {
    const onFailed = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          ),
        );
        // Give the reader a chance to actually observe the enqueued chunk before the stream
        // errors — enqueuing and erroring in the same synchronous tick races the reader.
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.error(new Error("upstream connection reset"));
      },
    });

    const response = buildChatStreamResponse(
      GRANITE.id,
      "req-1",
      GRANITE,
      upstream,
      {
        callbacks: { onFailed },
      },
    );
    const frames = await collectFrames(response);

    expect(frames.some((frame) => frame.type === "answer")).toBe(true);
    const errorFrame = frames.at(-1);
    expect(errorFrame).toMatchObject({ type: "error", status: 502 });
    expect(frames.every((frame) => frame.type !== "done")).toBe(true);
    expect(onFailed).toHaveBeenCalledWith(
      expect.objectContaining({ status: 502, detail: expect.any(String) }),
    );
  });

  it("aborts the abort controller and calls onAborted when the consumer cancels the stream", async () => {
    const onAborted = vi.fn();
    const abortController = new AbortController();
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
          ),
        );
      },
      cancel() {
        upstreamCancelled = true;
      },
    });

    const response = buildChatStreamResponse(
      GRANITE.id,
      "req-1",
      GRANITE,
      upstream,
      {
        abortController,
        callbacks: { onAborted },
      },
    );

    const reader = response.body?.getReader();
    if (!reader) throw new Error("response has no body");
    await reader.read();
    await reader.cancel();

    // Cancellation propagation is asynchronous; give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(abortController.signal.aborted).toBe(true);
    expect(upstreamCancelled).toBe(true);
    expect(onAborted).toHaveBeenCalledWith(
      expect.objectContaining({ totalMs: expect.any(Number) }),
    );
  });
});
