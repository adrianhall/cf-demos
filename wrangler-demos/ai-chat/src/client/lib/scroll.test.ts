import { describe, expect, it } from "vitest";
import { scrollToBottom } from "./scroll";

describe("scrollToBottom", () => {
  it("sets scrollTop to scrollHeight for an attached element", () => {
    const region = { scrollTop: 0, scrollHeight: 480 } as HTMLElement;

    scrollToBottom(region);

    expect(region.scrollTop).toBe(480);
  });

  it("does nothing when the region is null", () => {
    expect(() => scrollToBottom(null)).not.toThrow();
  });
});
