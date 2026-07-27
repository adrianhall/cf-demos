import { describe, expect, it } from "vitest";
import { validateMessageInput } from "./validation";

describe("validateMessageInput", () => {
  it("trims a valid text-frame body", () => {
    expect(validateMessageInput('{"body":"  Hello room  "}')).toEqual({
      body: "Hello room",
    });
  });

  it.each([
    "not json",
    '{"body":""}',
    '{"body":"line\u0001break"}',
    '{"body":"ok","author":"spoofed@example.com"}',
  ])("rejects invalid or spoofable payload %j", (payload) => {
    expect(() => validateMessageInput(payload)).toThrow();
  });

  it("rejects binary frames", () => {
    expect(() => validateMessageInput(new ArrayBuffer(1))).toThrow();
  });
});
