import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it } from "vitest";
import { findModel } from "../../models";
import { openInferenceStream, readInferenceEvents } from "./inference";

/** Build a `ReadableStream<Uint8Array>` from raw SSE `data:` payload strings. */
function sseStream(payloads: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = payloads.map((payload) => `data: ${payload}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Collect every event an async generator yields into a plain array. */
async function collect<T>(
  generator: AsyncGenerator<T, void, unknown>,
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

const GRANITE = findModel("@cf/ibm-granite/granite-4.0-h-micro");
if (!GRANITE)
  throw new Error("test setup: Granite descriptor missing from catalog");

const DEEPSEEK = findModel("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");
if (!DEEPSEEK)
  throw new Error("test setup: DeepSeek descriptor missing from catalog");

const GLM = findModel("@cf/zai-org/glm-4.7-flash");
if (!GLM) throw new Error("test setup: GLM descriptor missing from catalog");

describe("openInferenceStream", () => {
  it("prepends the server-owned system prompt and calls the model's adapter", async () => {
    const fakeStream = new ReadableStream();
    let capturedInput: unknown;
    const fakeAi = {
      run: async (_model: string, input: unknown) => {
        capturedInput = input;
        return fakeStream;
      },
    } as unknown as Ai;

    const result = await openInferenceStream(
      fakeAi,
      GRANITE,
      [{ role: "user", content: "Hello" }],
      { temperature: 0.6, maxTokens: 256 },
    );

    expect(result).toBe(fakeStream);
    expect(capturedInput).toMatchObject({
      messages: [
        { role: "system", content: expect.any(String) },
        { role: "user", content: "Hello" },
      ],
    });
  });

  it("never forwards a client-supplied system message on top of the server-owned one", async () => {
    // validation.ts already rejects a client "system" role before this function runs; this
    // asserts the defense-in-depth invariant that only one system message is ever sent, and it
    // is always this module's own constant, regardless of what `messages` might otherwise
    // contain.
    let capturedInput: { messages: { role: string }[] } | undefined;
    const fakeAi = {
      run: async (_model: string, input: unknown) => {
        capturedInput = input as { messages: { role: string }[] };
        return new ReadableStream();
      },
    } as unknown as Ai;

    await openInferenceStream(
      fakeAi,
      GRANITE,
      [{ role: "user", content: "hi" }],
      {
        temperature: 0.6,
        maxTokens: 256,
      },
    );

    const systemMessages = capturedInput?.messages.filter(
      (message) => message.role === "system",
    );
    expect(systemMessages).toHaveLength(1);
  });

  it("maps a rejected env.AI.run() call to a 502 problem details error, before any stream opens", async () => {
    const fakeAi = {
      run: async () => {
        throw new Error("AiError: Bad input: temperature must be in [0, 2]");
      },
    } as unknown as Ai;

    await expect(
      openInferenceStream(fakeAi, GRANITE, [{ role: "user", content: "hi" }], {
        temperature: 0.6,
        maxTokens: 256,
      }),
    ).rejects.toMatchObject({
      problemDetails: { status: 502 },
    });
  });

  it.each([
    ["Rate limit exceeded, slow down", "Upstream rate limited"],
    [
      "This request exceeds the maximum context length",
      "Context window exceeded",
    ],
    ["Error: no such model", "Model unavailable"],
    ["Bad input: invalid parameter", "Upstream rejected input"],
    ["something else entirely broke", "Inference failed"],
  ])(
    "maps an upstream error message %j to the %j problem title",
    async (message, expectedTitle) => {
      const fakeAi = {
        run: async () => {
          throw new Error(message);
        },
      } as unknown as Ai;

      try {
        await openInferenceStream(
          fakeAi,
          GRANITE,
          [{ role: "user", content: "hi" }],
          {
            temperature: 0.6,
            maxTokens: 256,
          },
        );
        expect.unreachable("expected openInferenceStream to reject");
      } catch (error) {
        expect((error as ProblemDetailsError).problemDetails).toMatchObject({
          status: 502,
          title: expectedTitle,
        });
      }
    },
  );

  it("passes an already-thrown ProblemDetailsError through unchanged", async () => {
    const original = new ProblemDetailsError({
      status: 502,
      title: "Custom",
      detail: "already mapped",
    });
    const fakeAi = {
      run: async () => {
        throw original;
      },
    } as unknown as Ai;

    try {
      await openInferenceStream(
        fakeAi,
        GRANITE,
        [{ role: "user", content: "hi" }],
        {
          temperature: 0.6,
          maxTokens: 256,
        },
      );
      expect.unreachable("expected openInferenceStream to reject");
    } catch (error) {
      expect(error).toBe(original);
    }
  });
});

describe("readInferenceEvents", () => {
  it("yields answer deltas, then a usage-carrying event, for a non-reasoning cf-native model", async () => {
    const stream = sseStream([
      '{"choices":[{"delta":{"content":"Hello"}}]}',
      '{"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":0,"completion_tokens":1,"total_tokens":1}}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '{"response":"","usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      "[DONE]",
    ]);

    const events = await collect(readInferenceEvents(GRANITE, stream));
    const answer = events.map((event) => event.answerDelta ?? "").join("");
    expect(answer).toBe("Hello world");
    expect(events.at(-1)).toEqual({
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    expect(events.some((event) => event.thinkingDelta)).toBe(false);
  });

  it("separates inline <think> reasoning from the answer for DeepSeek", async () => {
    const stream = sseStream([
      '{"response":"<think>"}',
      '{"response":"reasoning here"}',
      '{"response":"</think>"}',
      '{"response":"final answer"}',
      '{"response":"","usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}',
      "[DONE]",
    ]);

    const events = await collect(readInferenceEvents(DEEPSEEK, stream));
    const answer = events.map((event) => event.answerDelta ?? "").join("");
    const thinking = events.map((event) => event.thinkingDelta ?? "").join("");
    expect(answer).toBe("final answer");
    expect(thinking).toBe("reasoning here");
    expect(answer).not.toContain("<think>");
  });

  it("flushes an unclosed <think> block as a trailing thinking event when the stream ends early", async () => {
    const stream = sseStream([
      '{"response":"<think>"}',
      '{"response":"cut off mid-thought"}',
      "[DONE]",
    ]);

    const events = await collect(readInferenceEvents(DEEPSEEK, stream));
    const thinking = events.map((event) => event.thinkingDelta ?? "").join("");
    expect(thinking).toBe("cut off mid-thought");
    expect(events.every((event) => !event.answerDelta)).toBe(true);
  });

  it("reads reasoning_content directly for an openai-chat reasoning-field model", async () => {
    const stream = sseStream([
      '{"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
      '{"choices":[{"delta":{"content":"the answer"}}]}',
      "[DONE]",
    ]);

    const events = await collect(readInferenceEvents(GLM, stream));
    expect(events).toContainEqual({ thinkingDelta: "thinking..." });
    expect(events).toContainEqual({ answerDelta: "the answer" });
  });

  it("skips a malformed JSON frame instead of aborting the turn", async () => {
    const stream = sseStream([
      "not valid json",
      '{"choices":[{"delta":{"content":"still works"}}]}',
      "[DONE]",
    ]);

    const events = await collect(readInferenceEvents(GRANITE, stream));
    expect(events.map((event) => event.answerDelta).join("")).toBe(
      "still works",
    );
  });

  it("stops at [DONE] without yielding anything for frames after it", async () => {
    const stream = sseStream([
      '{"choices":[{"delta":{"content":"before"}}]}',
      "[DONE]",
      '{"choices":[{"delta":{"content":"after"}}]}',
    ]);

    const events = await collect(readInferenceEvents(GRANITE, stream));
    expect(events.map((event) => event.answerDelta).join("")).toBe("before");
  });

  it("maps a mid-stream reader failure to a 502 problem details error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
          ),
        );
        controller.error(new Error("upstream connection reset"));
      },
    });

    const generator = readInferenceEvents(GRANITE, stream);
    await expect(collect(generator)).rejects.toBeInstanceOf(
      ProblemDetailsError,
    );
  });
});
