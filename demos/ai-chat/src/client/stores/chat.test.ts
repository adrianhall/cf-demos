import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRequestBody, ChatStreamFrame } from "../../chat-protocol";
import { useChatStore } from "./chat";
import { useSettingsStore } from "./settings";

/** Encode a sequence of stream frames as one SSE response body, matching the Worker's wire format. */
function frameBody(frames: readonly ChatStreamFrame[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

/** Build a successful `text/event-stream` response carrying the given frames. */
function streamResponse(frames: readonly ChatStreamFrame[]): Response {
  return new Response(frameBody(frames), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("useChatStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends a turn, sends the current model/parameters, and fills in streamed deltas", async () => {
    let requestBody: ChatRequestBody | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body)) as ChatRequestBody;
        return Promise.resolve(
          streamResponse([
            { type: "start", model: requestBody.model, requestId: "r1" },
            { type: "answer", text: "The " },
            { type: "answer", text: "capital." },
            {
              type: "done",
              finishReason: "stop",
              ttftMs: 50,
              totalMs: 150,
              usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
            },
          ]),
        );
      }),
    );

    const settings = useSettingsStore();
    const chat = useChatStore();

    await chat.submit("What is the capital of France?");

    expect(requestBody).toEqual({
      model: settings.modelId,
      messages: [{ role: "user", content: "What is the capital of France?" }],
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    });

    expect(chat.turns).toHaveLength(1);
    const turn = chat.turns[0];
    expect(turn.userContent).toBe("What is the capital of France?");
    expect(turn.answer).toBe("The capital.");
    expect(turn.thinking).toBe("");
    expect(turn.status).toBe("done");
    expect(turn.ttftMs).toBe(50);
    expect(turn.totalMs).toBe(150);
    expect(turn.usage).toEqual({
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
    });
    expect(turn.modelId).toBe(settings.modelId);
    expect(chat.isStreaming).toBe(false);
  });

  it("accumulates thinking deltas separately from answer deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamResponse([
            { type: "start", model: "m", requestId: "r1" },
            { type: "thinking", text: "Step one. " },
            { type: "thinking", text: "Step two." },
            { type: "answer", text: "Done." },
            {
              type: "done",
              finishReason: "stop",
              ttftMs: 10,
              totalMs: 40,
              usage: null,
            },
          ]),
        ),
      ),
    );

    const chat = useChatStore();
    await chat.submit("Work it out.");

    expect(chat.turns[0].thinking).toBe("Step one. Step two.");
    expect(chat.turns[0].answer).toBe("Done.");
  });

  it("applies a thinking delta only to the turn it belongs to, leaving prior turns untouched", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        if (call === 1) {
          return Promise.resolve(
            streamResponse([
              { type: "start", model: "m", requestId: "r1" },
              { type: "answer", text: "First reply" },
              {
                type: "done",
                finishReason: "stop",
                ttftMs: 5,
                totalMs: 10,
                usage: null,
              },
            ]),
          );
        }
        return Promise.resolve(
          streamResponse([
            { type: "start", model: "m", requestId: "r2" },
            { type: "thinking", text: "Reasoning about the second question." },
            { type: "answer", text: "Second reply" },
            {
              type: "done",
              finishReason: "stop",
              ttftMs: 5,
              totalMs: 10,
              usage: null,
            },
          ]),
        );
      }),
    );

    const chat = useChatStore();
    await chat.submit("First question");
    await chat.submit("Second question");

    expect(chat.turns).toHaveLength(2);
    expect(chat.turns[0].thinking).toBe("");
    expect(chat.turns[0].answer).toBe("First reply");
    expect(chat.turns[1].thinking).toBe("Reasoning about the second question.");
    expect(chat.turns[1].answer).toBe("Second reply");
  });

  it("sends the accumulated conversation, including only turns with an answer, on the next turn", async () => {
    const requestBodies: ChatRequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as ChatRequestBody;
        requestBodies.push(body);
        return Promise.resolve(
          streamResponse([
            { type: "start", model: body.model, requestId: "r" },
            { type: "answer", text: `Reply ${requestBodies.length}` },
            {
              type: "done",
              finishReason: "stop",
              ttftMs: 10,
              totalMs: 20,
              usage: null,
            },
          ]),
        );
      }),
    );

    const chat = useChatStore();
    await chat.submit("First question");
    await chat.submit("Second question");

    expect(requestBodies[1]?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Reply 1" },
      { role: "user", content: "Second question" },
    ]);
  });

  it("excludes a turn with no answer text from the replayed conversation", async () => {
    const requestBodies: ChatRequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as ChatRequestBody;
        requestBodies.push(body);
        if (requestBodies.length === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ detail: "Workers AI inference failed." }),
              {
                status: 502,
                headers: { "content-type": "application/problem+json" },
              },
            ),
          );
        }
        return Promise.resolve(
          streamResponse([
            { type: "start", model: body.model, requestId: "r" },
            { type: "answer", text: "Second reply" },
            {
              type: "done",
              finishReason: "stop",
              ttftMs: 10,
              totalMs: 20,
              usage: null,
            },
          ]),
        );
      }),
    );

    const chat = useChatStore();
    await chat.submit("First question");
    expect(chat.turns[0].status).toBe("error");

    await chat.submit("Second question");

    expect(requestBodies[1]?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "user", content: "Second question" },
    ]);
  });

  it("records the model/parameters used per turn, independent of a later settings change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamResponse([
            { type: "start", model: "m", requestId: "r" },
            { type: "answer", text: "ok" },
            {
              type: "done",
              finishReason: "stop",
              ttftMs: 5,
              totalMs: 10,
              usage: null,
            },
          ]),
        ),
      ),
    );

    const settings = useSettingsStore();
    const chat = useChatStore();
    await chat.submit("First question");

    settings.selectModel("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");

    expect(chat.turns[0].modelId).toBe("@cf/ibm-granite/granite-4.0-h-micro");
  });

  it("marks the turn as an error and flags a session expiry for a 401 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: "Unauthorized." }), {
            status: 401,
            headers: { "content-type": "application/problem+json" },
          }),
        ),
      ),
    );

    const chat = useChatStore();
    await chat.submit("Hello");

    expect(chat.sessionExpired).toBe(true);
    expect(chat.turns[0].status).toBe("error");
    expect(chat.turns[0].errorDetail).toBe(
      "Your session expired. Sign in again to continue.",
    );
  });

  it("marks the turn as an error from an in-band error frame without flagging session expiry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamResponse([
            { type: "start", model: "m", requestId: "r" },
            { type: "answer", text: "partial" },
            {
              type: "error",
              status: 502,
              title: "Inference failed",
              detail: "Workers AI inference failed.",
            },
          ]),
        ),
      ),
    );

    const chat = useChatStore();
    await chat.submit("Hello");

    expect(chat.sessionExpired).toBe(false);
    expect(chat.turns[0].status).toBe("error");
    expect(chat.turns[0].errorDetail).toBe("Workers AI inference failed.");
    expect(chat.turns[0].answer).toBe("partial");
  });

  it("marks the turn as an error for an unexpected thrown Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Network request failed"))),
    );

    const chat = useChatStore();
    await chat.submit("Hello");

    expect(chat.sessionExpired).toBe(false);
    expect(chat.turns[0].status).toBe("error");
    expect(chat.turns[0].errorDetail).toBe("Network request failed");
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject("offline")),
    );

    const chat = useChatStore();
    await chat.submit("Hello");

    expect(chat.turns[0].status).toBe("error");
    expect(chat.turns[0].errorDetail).toBe("The request failed.");
  });

  it("does nothing for blank input", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const chat = useChatStore();
    await chat.submit("   ");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(chat.turns).toHaveLength(0);
  });

  it("ignores a second submit while a turn is already streaming", async () => {
    let releaseFirstResponse: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return streamResponse([
        { type: "start", model: "m", requestId: "r" },
        { type: "answer", text: "ok" },
        {
          type: "done",
          finishReason: "stop",
          ttftMs: 5,
          totalMs: 10,
          usage: null,
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const chat = useChatStore();
    const firstSubmit = chat.submit("First");
    await chat.submit("Second (ignored while streaming)");

    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirstResponse?.();
    await firstSubmit;
    expect(chat.turns).toHaveLength(1);
  });

  it("stop() cancels the in-flight request and marks the turn as stopped", async () => {
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          streamController?.error(new DOMException("Aborted", "AbortError"));
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }),
    );

    const chat = useChatStore();
    const submitPromise = chat.submit("Tell me a long story.");
    await vi.waitFor(() => expect(chat.isStreaming).toBe(true));

    chat.stop();
    await submitPromise;

    expect(chat.turns[0].status).toBe("stopped");
    expect(chat.turns[0].finishReason).toBe("cancelled");
    expect(chat.isStreaming).toBe(false);
  });

  it("stop() is a harmless no-op when nothing is streaming", () => {
    const chat = useChatStore();
    expect(() => chat.stop()).not.toThrow();
  });
});
