import { afterEach, describe, expect, it, vi } from "vitest";
import { generateExportFilename, triggerDownload } from "./export";

describe("generateExportFilename", () => {
  const fixedNow = new Date(2026, 0, 5, 9, 7);

  it("sanitizes the title and appends a date/time stamp and extension", () => {
    expect(generateExportFilename("My Architecture!", "png", fixedNow)).toBe(
      "My_Architecture_2026-01-05_0907.png",
    );
  });

  it("collapses repeated separators and punctuation into a single underscore", () => {
    expect(
      generateExportFilename("API  Gateway -- v2.0", "svg", fixedNow),
    ).toBe("API_Gateway_v2_0_2026-01-05_0907.svg");
  });

  it("trims leading and trailing underscores produced by punctuation", () => {
    expect(generateExportFilename("!!!Diagram!!!", "zip", fixedNow)).toBe(
      "Diagram_2026-01-05_0907.zip",
    );
  });

  it("falls back to 'diagram' for a blank or all-punctuation title", () => {
    expect(generateExportFilename("   ", "png", fixedNow)).toBe(
      "diagram_2026-01-05_0907.png",
    );
    expect(generateExportFilename("!!!", "png", fixedNow)).toBe(
      "diagram_2026-01-05_0907.png",
    );
  });

  it("pads single-digit month/day/hour/minute components", () => {
    const early = new Date(2026, 2, 3, 4, 5);
    expect(generateExportFilename("Diagram", "png", early)).toBe(
      "Diagram_2026-03-03_0405.png",
    );
  });

  it("defaults to the current date/time when none is provided", () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    expect(generateExportFilename("Diagram", "png")).toBe(
      "Diagram_2026-01-05_0907.png",
    );
    vi.useRealTimers();
  });
});

describe("triggerDownload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates, clicks, and removes a temporary anchor element", () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, "appendChild");
    const removeSpy = vi.spyOn(document.body, "removeChild");

    triggerDownload("blob:fake-url", "diagram.png");

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    const anchor = appendSpy.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(anchor.href).toBe("blob:fake-url");
    expect(anchor.download).toBe("diagram.png");
  });
});
