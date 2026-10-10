import { describe, expect, it } from "vitest";
import { anonymousViewer } from "./viewer";

describe("anonymousViewer", () => {
  it("uses a valid opaque browser identifier without exposing personal data", () => {
    expect(
      anonymousViewer(
        new Request(
          "https://media.example/api/library/item?viewer=adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
        ),
      ),
    ).toBe("anonymous:adf5b4e7-ae77-49d0-a9ee-d11aedf38d65");
  });

  it("does not log arbitrary public query data as a viewer identity", () => {
    expect(
      anonymousViewer(
        new Request(
          "https://media.example/api/library/item?viewer=person@example.com",
        ),
      ),
    ).toBe("anonymous:unknown");
  });
});
