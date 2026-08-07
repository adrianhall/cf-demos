import { describe, expect, it } from "vitest";
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_PROMPT_LENGTH,
  validateStartProposalInput,
} from "./validation";

describe("validateStartProposalInput", () => {
  it("accepts a trimmed prompt with no idempotency key", () => {
    expect(validateStartProposalInput({ prompt: "  Build an API  " })).toEqual({
      prompt: "Build an API",
    });
  });

  it("accepts a prompt with an idempotency key", () => {
    expect(
      validateStartProposalInput({
        prompt: "Build an API",
        idempotencyKey: "key-1",
      }),
    ).toEqual({ prompt: "Build an API", idempotencyKey: "key-1" });
  });

  it("rejects a non-object body", () => {
    expect(() => validateStartProposalInput(null)).toThrow();
  });

  it("rejects a missing prompt", () => {
    expect(() => validateStartProposalInput({})).toThrow();
  });

  it("rejects an empty (post-trim) prompt", () => {
    expect(() => validateStartProposalInput({ prompt: "   " })).toThrow();
  });

  it("rejects a prompt over the max length", () => {
    expect(() =>
      validateStartProposalInput({ prompt: "a".repeat(MAX_PROMPT_LENGTH + 1) }),
    ).toThrow();
  });

  it("accepts a prompt at exactly the max length", () => {
    const prompt = "a".repeat(MAX_PROMPT_LENGTH);
    expect(validateStartProposalInput({ prompt })).toEqual({ prompt });
  });

  it("rejects a non-string idempotency key", () => {
    expect(() =>
      validateStartProposalInput({ prompt: "Build an API", idempotencyKey: 5 }),
    ).toThrow();
  });

  it("rejects an idempotency key over the max length", () => {
    expect(() =>
      validateStartProposalInput({
        prompt: "Build an API",
        idempotencyKey: "a".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
      }),
    ).toThrow();
  });
});
