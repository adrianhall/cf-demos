import { describe, expect, it } from "vitest";
import { formatFileSize } from "./media";

describe("formatFileSize", () => {
  it("formats kilobyte and megabyte media sizes", () => {
    expect(formatFileSize(12)).toBe("1 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
