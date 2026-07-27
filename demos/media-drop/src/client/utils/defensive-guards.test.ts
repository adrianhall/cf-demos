import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./defensive-guards";

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
