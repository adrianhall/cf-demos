import { describe, expect, it, vi } from "vitest";
import { buildInput, readChunk, run } from "./openai-chat";

describe("openai-chat adapter: buildInput", () => {
  it("uses max_completion_tokens, not max_tokens", () => {
    const input = buildInput([{ role: "user", content: "hi" }], {
      temperature: 0.6,
      maxTokens: 512,
    });
    expect(input.max_completion_tokens).toBe(512);
    expect(input).not.toHaveProperty("max_tokens");
  });

  it("always sets stream_options.include_usage", () => {
    const input = buildInput([{ role: "user", content: "hi" }], {
      temperature: 0.6,
      maxTokens: 512,
    });
    expect(input.stream_options).toEqual({ include_usage: true });
  });

  it("sets stream: true and passes temperature through", () => {
    const input = buildInput([{ role: "user", content: "hi" }], {
      temperature: 1.2,
      maxTokens: 100,
    });
    expect(input.stream).toBe(true);
    expect(input.temperature).toBe(1.2);
  });
});

describe("openai-chat adapter: run", () => {
  it("calls ai.run with the model id, input, and abort signal", async () => {
    const fakeStream = new ReadableStream();
    const aiRun = vi.fn().mockResolvedValue(fakeStream);
    const fakeAi = { run: aiRun } as unknown as Ai;
    const controller = new AbortController();

    const input = buildInput([{ role: "user", content: "hi" }], {
      temperature: 0.6,
      maxTokens: 100,
    });
    const result = await run(
      fakeAi,
      "@cf/zai-org/glm-4.7-flash",
      input,
      controller.signal,
    );

    expect(result).toBe(fakeStream);
    expect(aiRun).toHaveBeenCalledWith("@cf/zai-org/glm-4.7-flash", input, {
      signal: controller.signal,
    });
  });
});

describe("openai-chat adapter: readChunk", () => {
  it("reads the answer text delta", () => {
    const chunk = JSON.parse(
      '{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
    );
    expect(readChunk(chunk)).toEqual({ answerDelta: "Hello" });
  });

  it("reads the reasoning_content delta as thinkingDelta", () => {
    const chunk = JSON.parse(
      '{"choices":[{"delta":{"reasoning_content":"The user wants..."},"finish_reason":null}]}',
    );
    expect(readChunk(chunk)).toEqual({ thinkingDelta: "The user wants..." });
  });

  it("reads both an answer and reasoning delta from the same chunk when present", () => {
    const chunk = JSON.parse(
      '{"choices":[{"delta":{"content":"answer","reasoning_content":"reasoning"}}]}',
    );
    expect(readChunk(chunk)).toEqual({
      answerDelta: "answer",
      thinkingDelta: "reasoning",
    });
  });

  it("reads finish_reason", () => {
    const chunk = JSON.parse(
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    );
    expect(readChunk(chunk)).toEqual({ finishReason: "stop" });
  });

  it("reads usage from a delta chunk", () => {
    const chunk = JSON.parse(
      '{"choices":[{"delta":{"content":"x"}}],"usage":{"prompt_tokens":0,"completion_tokens":1,"total_tokens":1}}',
    );
    expect(readChunk(chunk).usage).toEqual({
      promptTokens: 0,
      completionTokens: 1,
      totalTokens: 1,
    });
  });

  it("reads the universal terminal frame (no choices key) shared by every catalog model", () => {
    const chunk = JSON.parse(
      '{"response":"","usage":{"prompt_tokens":16,"completion_tokens":201,"total_tokens":217}}',
    );
    expect(readChunk(chunk)).toEqual({
      usage: { promptTokens: 16, completionTokens: 201, totalTokens: 217 },
    });
  });

  it("returns an empty object for a non-object payload rather than throwing", () => {
    expect(readChunk("nope")).toEqual({});
    expect(readChunk(undefined)).toEqual({});
  });
});
