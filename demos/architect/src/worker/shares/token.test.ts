import { describe, expect, it } from "vitest";
import {
  digestShareToken,
  generateShareToken,
  isWellFormedShareToken,
  SHARE_TOKEN_LENGTH,
} from "./token";

describe("generateShareToken", () => {
  it("produces a well-formed, unique token each call", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).toHaveLength(SHARE_TOKEN_LENGTH);
    expect(b).toHaveLength(SHARE_TOKEN_LENGTH);
    expect(a).not.toBe(b);
    expect(isWellFormedShareToken(a)).toBe(true);
    expect(isWellFormedShareToken(b)).toBe(true);
  });

  it("never contains base64 padding or URL-unsafe characters", () => {
    const token = generateShareToken();
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
  });
});

describe("digestShareToken", () => {
  it("is deterministic for the same input", async () => {
    const token = generateShareToken();
    const first = await digestShareToken(token);
    const second = await digestShareToken(token);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("differs for different tokens", async () => {
    const first = await digestShareToken(generateShareToken());
    const second = await digestShareToken(generateShareToken());
    expect(first).not.toBe(second);
  });
});

describe("isWellFormedShareToken", () => {
  it("rejects the wrong length", () => {
    expect(isWellFormedShareToken("too-short")).toBe(false);
    expect(isWellFormedShareToken(`${generateShareToken()}x`)).toBe(false);
  });

  it("rejects characters outside the base64url alphabet", () => {
    const invalid = `${"a".repeat(SHARE_TOKEN_LENGTH - 1)}=`;
    expect(isWellFormedShareToken(invalid)).toBe(false);
  });

  it("accepts a genuinely generated token", () => {
    expect(isWellFormedShareToken(generateShareToken())).toBe(true);
  });
});
