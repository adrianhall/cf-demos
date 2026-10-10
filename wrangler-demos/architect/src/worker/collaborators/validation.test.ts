import { describe, expect, it } from "vitest";
import {
  validateAddCollaboratorInput,
  validateCollaboratorEmailParam,
} from "./validation";

describe("validateAddCollaboratorInput", () => {
  it("accepts and trims a well-formed email", () => {
    expect(validateAddCollaboratorInput({ email: " a@example.com " })).toBe(
      "a@example.com",
    );
  });

  it("rejects a non-object body", () => {
    expect(() => validateAddCollaboratorInput("not an object")).toThrow();
    expect(() => validateAddCollaboratorInput(null)).toThrow();
    expect(() => validateAddCollaboratorInput([])).toThrow();
  });

  it("rejects a body missing email", () => {
    expect(() => validateAddCollaboratorInput({})).toThrow();
  });

  it("rejects a non-string email", () => {
    expect(() => validateAddCollaboratorInput({ email: 42 })).toThrow();
  });

  it("rejects an empty or whitespace-only email", () => {
    expect(() => validateAddCollaboratorInput({ email: "   " })).toThrow();
  });

  it("rejects a value not shaped like an email address", () => {
    expect(() =>
      validateAddCollaboratorInput({ email: "not-an-email" }),
    ).toThrow();
  });

  it("rejects an email exceeding the maximum length", () => {
    const longLocal = "a".repeat(315);
    expect(() =>
      validateAddCollaboratorInput({ email: `${longLocal}@example.com` }),
    ).toThrow();
  });
});

describe("validateCollaboratorEmailParam", () => {
  it("accepts a well-formed email", () => {
    expect(validateCollaboratorEmailParam("a@example.com")).toBe(
      "a@example.com",
    );
  });

  it("throws not found for a malformed value", () => {
    expect(() => validateCollaboratorEmailParam("not-an-email")).toThrow();
  });

  it("throws not found for an overly long value", () => {
    const longLocal = "a".repeat(315);
    expect(() =>
      validateCollaboratorEmailParam(`${longLocal}@example.com`),
    ).toThrow();
  });
});
