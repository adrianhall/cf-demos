import { describe, expect, it } from "vitest";
import type { ChatStreamFrame } from "../../chat-protocol";
import { ChatResponseError, readChatStream } from "./stream-reader";

/** Build a fake `text/event-stream` response body from pre-encoded SSE frame text. */
function eventStreamResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/event-stream",
      ...init.headers,
    },
  });
}

/** Drain every frame the reader yields into a plain array, for easy assertion. */
async function collect(response: Response): Promise<ChatStreamFrame[]> {
  const frames: ChatStreamFrame[] = [];
  for await (const frame of readChatStream(response)) {
    frames.push(frame);
  }
  return frames;
}

describe("readChatStream", () => {
  it("decodes an ordered sequence of frames from a successful event stream", async () => {
    const startFrame: ChatStreamFrame = {
      type: "start",
      model: "@cf/ibm-granite/granite-4.0-h-micro",
      requestId: "abc",
    };
    const answerFrame: ChatStreamFrame = { type: "answer", text: "Hi" };
    const doneFrame: ChatStreamFrame = {
      type: "done",
      finishReason: "stop",
      ttftMs: 100,
      totalMs: 200,
      usage: null,
    };
    const body =
      `data: ${JSON.stringify(startFrame)}\n\n` +
      `data: ${JSON.stringify(answerFrame)}\n\n` +
      `data: ${JSON.stringify(doneFrame)}\n\n`;

    await expect(collect(eventStreamResponse(body))).resolves.toEqual([
      startFrame,
      answerFrame,
      doneFrame,
    ]);
  });

  it("throws a ChatResponseError for a non-stream error response", async () => {
    const response = new Response(
      JSON.stringify({ detail: "model must be an exact ID from the catalog." }),
      { status: 422, headers: { "content-type": "application/problem+json" } },
    );

    await expect(collect(response)).rejects.toMatchObject({
      name: "ChatResponseError",
      status: 422,
      message: "model must be an exact ID from the catalog.",
      sessionExpired: false,
    });
  });

  it("marks a 401 response as a session expiry", async () => {
    const response = new Response(JSON.stringify({ detail: "Unauthorized." }), {
      status: 401,
      headers: { "content-type": "application/problem+json" },
    });

    await expect(collect(response)).rejects.toMatchObject({
      status: 401,
      sessionExpired: true,
    });
  });

  it("marks a 403 response as a session expiry", async () => {
    const response = new Response(JSON.stringify({ detail: "Forbidden." }), {
      status: 403,
      headers: { "content-type": "application/problem+json" },
    });

    await expect(collect(response)).rejects.toMatchObject({
      status: 403,
      sessionExpired: true,
    });
  });

  it("falls back to a generic message when the error body is not problem details", async () => {
    const response = new Response("upstream failure", { status: 502 });

    await expect(collect(response)).rejects.toMatchObject({
      status: 502,
      message: "Request failed with status 502.",
    });
  });

  it("rejects a response with a stream content type but no body", async () => {
    const response = eventStreamResponse("");
    Object.defineProperty(response, "body", { value: null });

    await expect(collect(response)).rejects.toMatchObject({
      status: 200,
      message: "The response had no body to stream.",
    });
  });

  it("treats a response with no Content-Type header at all as a non-stream response", async () => {
    // A `null` body (rather than a string, which the Fetch API auto-labels `text/plain`) is the
    // only way to construct a `Response` with no Content-Type header at all, exercising the `??
    // ""` fallback this function's Content-Type check relies on.
    const response = new Response(null, { status: 200 });

    await expect(collect(response)).rejects.toBeInstanceOf(ChatResponseError);
  });
});
