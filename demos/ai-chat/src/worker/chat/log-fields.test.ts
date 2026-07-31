import { describe, expect, it } from "vitest";
import {
  buildInferenceLogFields,
  type InferenceLogFieldsInput,
} from "./log-fields";

describe("buildInferenceLogFields", () => {
  it("includes only the required fields when nothing else is known", () => {
    const fields = buildInferenceLogFields({
      model: "@cf/ibm-granite/granite-4.0-h-micro",
      requestId: "req-1",
      messageCount: 1,
      totalCharacters: 12,
    });
    expect(fields).toEqual({
      model: "@cf/ibm-granite/granite-4.0-h-micro",
      requestId: "req-1",
      messageCount: 1,
      totalCharacters: 12,
    });
  });

  it("includes timing fields once known", () => {
    const fields = buildInferenceLogFields({
      model: "x",
      requestId: "req-1",
      messageCount: 1,
      totalCharacters: 12,
      ttftMs: 120,
      totalMs: 900,
    });
    expect(fields.ttftMs).toBe(120);
    expect(fields.totalMs).toBe(900);
  });

  it("omits ttftMs when null (no token arrived before the turn ended)", () => {
    const fields = buildInferenceLogFields({
      model: "x",
      requestId: "req-1",
      messageCount: 1,
      totalCharacters: 12,
      ttftMs: null,
    });
    expect(fields).not.toHaveProperty("ttftMs");
  });

  it("flattens usage into promptTokens/completionTokens/totalTokens", () => {
    const fields = buildInferenceLogFields({
      model: "x",
      requestId: "req-1",
      messageCount: 1,
      totalCharacters: 12,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });
    expect(fields.promptTokens).toBe(10);
    expect(fields.completionTokens).toBe(20);
    expect(fields.totalTokens).toBe(30);
  });

  it("omits usage fields when usage is null", () => {
    const fields = buildInferenceLogFields({
      model: "x",
      requestId: "req-1",
      messageCount: 1,
      totalCharacters: 12,
      usage: null,
    });
    expect(fields).not.toHaveProperty("promptTokens");
  });

  it("includes finishReason, status, and detail when provided", () => {
    const fields = buildInferenceLogFields({
      model: "x",
      requestId: "req-1",
      messageCount: 1,
      totalCharacters: 12,
      finishReason: "stop",
      status: 502,
      detail: "Workers AI inference failed for the selected model.",
    });
    expect(fields.finishReason).toBe("stop");
    expect(fields.status).toBe(502);
    expect(fields.detail).toBe(
      "Workers AI inference failed for the selected model.",
    );
  });

  it("structurally cannot emit conversation content: the output never contains a content/prompt/answer/text key even under a smuggled input", () => {
    // InferenceLogFieldsInput has no field for message content at all, so this cast is the only
    // way to even attempt smuggling one through — and the function still cannot read it, because
    // it only ever assigns its own named fields onto the result.
    const smuggled = {
      model: "x",
      requestId: "req-1",
      messageCount: 1,
      totalCharacters: 12,
      content: "the user's actual prompt",
      prompt: "the user's actual prompt",
      answer: "the model's actual answer",
      text: "some text",
    } as unknown as InferenceLogFieldsInput;

    const fields = buildInferenceLogFields(smuggled);

    for (const forbiddenKey of ["content", "prompt", "answer", "text"]) {
      expect(fields).not.toHaveProperty(forbiddenKey);
    }
    expect(JSON.stringify(fields)).not.toContain("actual prompt");
    expect(JSON.stringify(fields)).not.toContain("actual answer");
  });
});
