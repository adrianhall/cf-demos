import { describe, expect, it } from "vitest";
import { validateChannelName, validateCreateChannelInput } from "./validation";

describe("validateChannelName", () => {
  it("normalizes a valid channel name before it becomes a Durable Object name", () => {
    expect(validateChannelName("  Engineering-42 ")).toBe("engineering-42");
  });

  it.each(["", "-starts-with-a-hyphen", "has spaces", "api", "a".repeat(33)])(
    "rejects unsafe or reserved channel name %j",
    (name) => {
      expect(() => validateChannelName(name)).toThrow();
    },
  );
});

describe("validateCreateChannelInput", () => {
  it("accepts exactly one name field", () => {
    expect(validateCreateChannelInput({ name: "Plans" })).toEqual({
      name: "plans",
    });
  });

  it("rejects unrelated fields", () => {
    expect(() =>
      validateCreateChannelInput({ name: "plans", owner: "alice" }),
    ).toThrow();
  });
});
