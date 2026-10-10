import { beforeEach, describe, expect, it, vi } from "vitest";
import { anonymousViewerId, publicViewerUrl } from "./viewer";

describe("anonymousViewerId", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reuses a persisted anonymous viewer identifier", () => {
    localStorage.setItem("media-drop.viewer-id", "saved-viewer");

    expect(anonymousViewerId()).toBe("saved-viewer");
  });

  it("creates and appends an opaque viewer identifier", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
    );

    expect(publicViewerUrl("/api/library/item?filter=recent")).toBe(
      "/api/library/item?filter=recent&viewer=adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
    );
    expect(localStorage.getItem("media-drop.viewer-id")).toBe(
      "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
    );
  });
});
