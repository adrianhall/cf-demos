import { describe, expect, it } from "vitest";
import { constantTimeEqual, hmacSha256Hex } from "./webhook-crypto";

describe("hmacSha256Hex", () => {
  it("computes a known HMAC-SHA-256 hex digest (RFC 4231 test case 1, truncated key)", async () => {
    // RFC 4231 test case 1: key = 0x0b repeated 20 times, data = "Hi There".
    const key = "\x0b".repeat(20);
    const digest = await hmacSha256Hex(key, "Hi There");

    expect(digest).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("produces different digests for different secrets", async () => {
    const digestA = await hmacSha256Hex("secret-a", "payload");
    const digestB = await hmacSha256Hex("secret-b", "payload");

    expect(digestA).not.toBe(digestB);
  });

  it("produces a 64-character lowercase hex string", async () => {
    const digest = await hmacSha256Hex("secret", "payload");

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("sha256=abc123", "sha256=abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("sha256=abc123", "sha256=abc124")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(constantTimeEqual("short", "a-much-longer-string")).toBe(false);
  });

  it("returns false when compared against an empty string", () => {
    expect(constantTimeEqual("non-empty", "")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
