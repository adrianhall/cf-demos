import { describe, expect, it } from "vitest";
import {
  digestInvitationToken,
  generateInvitationToken,
  isWellFormedInvitationToken,
} from "./token";

describe("generateInvitationToken", () => {
  it("generates a 43-character base64url token", () => {
    const token = generateInvitationToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("generates a different token on every call", () => {
    const tokens = new Set(
      Array.from({ length: 25 }, () => generateInvitationToken()),
    );
    expect(tokens.size).toBe(25);
  });
});

describe("isWellFormedInvitationToken", () => {
  it("recognizes a freshly generated token as well-formed", () => {
    expect(isWellFormedInvitationToken(generateInvitationToken())).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isWellFormedInvitationToken("")).toBe(false);
  });

  it("rejects a token that is too short", () => {
    expect(isWellFormedInvitationToken("too-short")).toBe(false);
  });

  it("rejects a token that is too long", () => {
    expect(isWellFormedInvitationToken(`${generateInvitationToken()}x`)).toBe(
      false,
    );
  });

  it("rejects a token containing characters outside the base64url alphabet", () => {
    expect(isWellFormedInvitationToken("!".repeat(43))).toBe(false);
  });
});

describe("digestInvitationToken", () => {
  it("computes a deterministic 64-character hex digest for the same token", async () => {
    const token = generateInvitationToken();
    const digestA = await digestInvitationToken(token);
    const digestB = await digestInvitationToken(token);
    expect(digestA).toBe(digestB);
    expect(digestA).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("computes different digests for different tokens", async () => {
    const tokenA = generateInvitationToken();
    const tokenB = generateInvitationToken();
    expect(await digestInvitationToken(tokenA)).not.toBe(
      await digestInvitationToken(tokenB),
    );
  });
});
