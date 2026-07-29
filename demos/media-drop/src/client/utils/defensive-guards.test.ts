import { describe, expect, it, vi } from "vitest";
import {
  getErrorMessage,
  parseJsonOrEmpty,
  wrapOnProgress,
} from "./defensive-guards";

describe("getErrorMessage", () => {
  it("returns the message from an Error instance", () => {
    expect(getErrorMessage(new Error("Library unavailable"), "Fallback")).toBe(
      "Library unavailable",
    );
  });

  it.each([undefined, null, "offline", { message: "not an Error" }])(
    "returns the fallback for a non-Error value: %j",
    (error) => {
      expect(getErrorMessage(error, "Could not load the library.")).toBe(
        "Could not load the library.",
      );
    },
  );
});

describe("parseJsonOrEmpty", () => {
  it("parses non-empty JSON text", () => {
    expect(parseJsonOrEmpty<{ media: string }>('{"media":"ready"}')).toEqual({
      media: "ready",
    });
  });

  it("treats an empty string as an empty object", () => {
    expect(parseJsonOrEmpty<Record<string, never>>("")).toEqual({});
  });

  it("still throws for non-empty, invalid JSON", () => {
    expect(() => parseJsonOrEmpty("{")).toThrow(SyntaxError);
  });
});

describe("wrapOnProgress", () => {
  it("reports a rounded percentage when the event is length-computable", () => {
    const onProgress = vi.fn();

    wrapOnProgress(onProgress, {
      lengthComputable: true,
      loaded: 6,
      total: 12,
    } as ProgressEvent);

    expect(onProgress).toHaveBeenCalledWith(50);
  });

  it("does not invoke the handler when the total size is unknown", () => {
    const onProgress = vi.fn();

    wrapOnProgress(onProgress, {
      lengthComputable: false,
      loaded: 6,
      total: 0,
    } as ProgressEvent);

    expect(onProgress).not.toHaveBeenCalled();
  });
});
