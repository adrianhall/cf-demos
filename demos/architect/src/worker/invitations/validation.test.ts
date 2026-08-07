import { describe, expect, it } from "vitest";
import { generateInvitationToken } from "./token";
import { validateRedeemInvitationInput } from "./validation";

describe("validateRedeemInvitationInput", () => {
  it("accepts a well-formed token", () => {
    const token = generateInvitationToken();
    expect(validateRedeemInvitationInput({ token })).toEqual({ token });
  });

  it("rejects a non-object body", () => {
    expect(() => validateRedeemInvitationInput("nope")).toThrow();
    expect(() => validateRedeemInvitationInput(null)).toThrow();
    expect(() => validateRedeemInvitationInput([1, 2])).toThrow();
  });

  it("rejects a missing token", () => {
    expect(() => validateRedeemInvitationInput({})).toThrow();
    try {
      validateRedeemInvitationInput({});
      throw new Error("expected validateRedeemInvitationInput to throw");
    } catch (error) {
      expect(error).toMatchObject({ problemDetails: { status: 422 } });
    }
  });

  it("rejects a malformed token", () => {
    expect(() =>
      validateRedeemInvitationInput({ token: "not-a-real-token" }),
    ).toThrow();
  });
});
