import { describe, expect, it, vi } from "vitest";
import { buildInput, readChunk, run } from "./cf-native";

describe("cf-native adapter: buildInput", () => {
  it("always sends an explicit max_tokens, never omitting it to the model's own default", () => {
    const input = buildInput([{ role: "user", content: "hi" }], {
      temperature: 0.6,
      maxTokens: 512,
    });
    expect(input.max_tokens).toBe(512);
  });

  it("sets stream: true and passes temperature through", () => {
    const input = buildInput([{ role: "user", content: "hi" }], {
      temperature: 1.5,
      maxTokens: 100,
    });
    expect(input.stream).toBe(true);
    expect(input.temperature).toBe(1.5);
  });

  it("passes the full message array through unchanged, including the system prompt", () => {
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hi" },
    ];
    const input = buildInput(messages, { temperature: 0.6, maxTokens: 100 });
    expect(input.messages).toEqual(messages);
  });
});

describe("cf-native adapter: run", () => {
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
      "@cf/ibm-granite/granite-4.0-h-micro",
      input,
      controller.signal,
    );

    expect(result).toBe(fakeStream);
    expect(aiRun).toHaveBeenCalledWith(
      "@cf/ibm-granite/granite-4.0-h-micro",
      input,
      { signal: controller.signal },
    );
  });
});

describe("cf-native adapter: readChunk", () => {
  it("reads a Granite/Scout-style OpenAI delta chunk's answer text (spike-verified shape)", () => {
    const chunk = JSON.parse(
      '{"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}],"usage":{"prompt_tokens":0,"completion_tokens":1,"total_tokens":1}}',
    );
    expect(readChunk(chunk)).toEqual({
      answerDelta: "Hello",
      usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 },
    });
  });

  it("reads a DeepSeek-style plain response chunk's answer text", () => {
    const chunk = JSON.parse(
      '{"response":"Hello","usage":{"prompt_tokens":0,"completion_tokens":1,"total_tokens":1}}',
    );
    expect(readChunk(chunk)).toEqual({
      answerDelta: "Hello",
      usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 },
    });
  });

  it("never populates thinkingDelta, even when a reasoning_content field is present", () => {
    const chunk = JSON.parse(
      '{"choices":[{"delta":{"content":"x","reasoning_content":"should be ignored"}}]}',
    );
    expect(readChunk(chunk).thinkingDelta).toBeUndefined();
  });

  it("reads finish_reason from an OpenAI-delta-shaped chunk", () => {
    const chunk = JSON.parse(
      '{"choices":[{"delta":{},"finish_reason":"length"}]}',
    );
    expect(readChunk(chunk)).toEqual({ finishReason: "length" });
  });

  it("reads the universal terminal frame (no choices key) shared by every catalog model", () => {
    const chunk = JSON.parse(
      '{"response":"","usage":{"prompt_tokens":37,"completion_tokens":3,"total_tokens":40}}',
    );
    expect(readChunk(chunk)).toEqual({
      usage: { promptTokens: 37, completionTokens: 3, totalTokens: 40 },
    });
  });

  it("reads an empty-choices intermediate frame as an empty result", () => {
    const chunk = JSON.parse(
      '{"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}',
    );
    expect(readChunk(chunk)).toEqual({
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  });

  it("returns an empty object for a non-object payload rather than throwing", () => {
    expect(readChunk("not an object")).toEqual({});
    expect(readChunk(null)).toEqual({});
    expect(readChunk(42)).toEqual({});
  });

  it("returns an empty object for an object with none of the recognized fields", () => {
    expect(readChunk({ unrelated: true })).toEqual({});
  });
});
