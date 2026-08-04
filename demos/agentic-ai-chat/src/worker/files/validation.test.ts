import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_BYTES,
  sanitizeFilename,
  validateMarkdownContent,
} from "./validation";

describe("sanitizeFilename", () => {
  it("appends a .md extension when none was supplied", () => {
    expect(sanitizeFilename("trip-itinerary")).toBe("trip-itinerary.md");
  });

  it("replaces an existing extension with exactly one .md", () => {
    expect(sanitizeFilename("notes.txt")).toBe("notes.md");
    expect(sanitizeFilename("notes.md")).toBe("notes.md");
    expect(sanitizeFilename("notes.MD")).toBe("notes.md");
  });

  it("strips a directory component so this can never escape its chat-scoped R2 prefix", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd.md");
    expect(sanitizeFilename("a/b/c")).toBe("c.md");
  });

  it("replaces characters outside the safe charset with a single dash", () => {
    expect(sanitizeFilename("Trip: Itinerary!!")).toBe("Trip-Itinerary.md");
  });

  it("strips leading/trailing dots, dashes, and whitespace", () => {
    expect(sanitizeFilename("  .-notes-.  ")).toBe("notes.md");
  });

  it("returns null when nothing usable remains", () => {
    expect(sanitizeFilename("")).toBeNull();
    expect(sanitizeFilename("   ")).toBeNull();
    expect(sanitizeFilename("...")).toBeNull();
    expect(sanitizeFilename("/../")).toBeNull();
  });

  it("truncates an overlong filename while still ending in exactly one .md", () => {
    const result = sanitizeFilename(`${"a".repeat(500)}.txt`);
    expect(result).not.toBeNull();
    expect(result?.endsWith(".md")).toBe(true);
    expect(result?.length).toBeLessThanOrEqual(128);
  });
});

describe("validateMarkdownContent", () => {
  it("returns the content unchanged when valid", () => {
    expect(validateMarkdownContent("# Hello")).toBe("# Hello");
  });

  it("rejects empty or whitespace-only content", () => {
    expect(() => validateMarkdownContent("")).toThrow("must not be empty");
    expect(() => validateMarkdownContent("   \n  ")).toThrow(
      "must not be empty",
    );
  });

  it("rejects content over the byte cap", () => {
    const oversized = "a".repeat(MAX_CONTENT_BYTES + 1);
    expect(() => validateMarkdownContent(oversized)).toThrow(
      `must not exceed ${MAX_CONTENT_BYTES} bytes`,
    );
  });

  it("accepts content exactly at the byte cap", () => {
    const atCap = "a".repeat(MAX_CONTENT_BYTES);
    expect(validateMarkdownContent(atCap)).toBe(atCap);
  });
});
