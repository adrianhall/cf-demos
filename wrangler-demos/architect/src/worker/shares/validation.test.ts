import { describe, expect, it } from "vitest";
import { validateShareToken } from "./validation";

/** A well-formed 43-character base64url token, matching `./repository.ts`'s `randomToken()`. */
const VALID_TOKEN = "A".repeat(43);

describe("validateShareToken", () => {
  it("accepts a well-formed 43-character base64url token", () => {
    expect(validateShareToken(VALID_TOKEN)).toBe(VALID_TOKEN);
  });

  it("accepts tokens containing '-' and '_'", () => {
    const token = `${"a".repeat(41)}-_`;
    expect(validateShareToken(token)).toBe(token);
  });

  it("rejects a token that is too short", () => {
    expect(() => validateShareToken("a".repeat(42))).toThrow();
  });

  it("rejects a token that is too long", () => {
    expect(() => validateShareToken("a".repeat(44))).toThrow();
  });

  it("rejects a token containing characters outside the base64url alphabet", () => {
    expect(() => validateShareToken(`${"a".repeat(42)}+`)).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => validateShareToken("")).toThrow();
  });

  it("reports the same problem detail as an unknown or revoked token, for a malformed one", () => {
    try {
      validateShareToken("not-a-real-token");
      throw new Error("expected validateShareToken to throw");
    } catch (error) {
      expect(String(error)).toMatch(/not found or revoked/iu);
    }
  });
});
