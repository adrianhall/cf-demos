import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadTextFile } from "./download";

// jsdom does not implement the Blob URL registry at all, so these are plain assignments rather
// than `vi.spyOn()` (which requires the property to already exist as a function).
describe("downloadTextFile", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an object URL, clicks a temporary anchor, and revokes the URL", () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    downloadTextFile("transcript.md", "# Hello");

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("revokes the object URL even if the click throws", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("blocked by a popup blocker");
    });

    expect(() => downloadTextFile("transcript.md", "# Hello")).toThrow();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });
});
