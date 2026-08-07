import { describe, expect, it } from "vitest";
import { generateShareToken } from "./token";
import { validateResolveShareInput } from "./validation";

describe("validateResolveShareInput", () => {
  it("accepts a well-formed token", () => {
    const token = generateShareToken();
    expect(validateResolveShareInput({ token })).toEqual({ token });
  });

  it("rejects a missing token field with the same generic error as an unknown token", () => {
    expect(() => validateResolveShareInput({})).toThrow(/not valid/u);
  });

  it("rejects a non-object body", () => {
    expect(() => validateResolveShareInput("not-an-object")).toThrow(
      /not valid/u,
    );
    expect(() => validateResolveShareInput(null)).toThrow(/not valid/u);
  });

  it("rejects a malformed token shape", () => {
    expect(() => validateResolveShareInput({ token: "too-short" })).toThrow(
      /not valid/u,
    );
  });

  it("rejects a non-string token field", () => {
    expect(() => validateResolveShareInput({ token: 12345 })).toThrow(
      /not valid/u,
    );
  });
});
