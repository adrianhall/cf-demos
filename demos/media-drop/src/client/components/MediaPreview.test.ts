import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { MediaItem } from "../media";
import MediaPreview from "./MediaPreview.vue";

/** Create media metadata for preview element selection tests. */
function media(contentType: string): MediaItem {
  return {
    contentType,
    createdAt: "2026-07-27T12:00:00.000Z",
    id: "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
    publishedAt: null,
    sizeBytes: 12,
    status: "published",
    title: "Sample media",
    updatedAt: "2026-07-27T12:00:00.000Z",
  };
}

describe("MediaPreview", () => {
  it("renders an accessible image preview", () => {
    const wrapper = mount(MediaPreview, {
      props: { media: media("image/png"), source: "/media.png" },
    });

    expect(wrapper.get("img").attributes()).toMatchObject({
      alt: "Sample media",
      src: "/media.png",
    });
  });

  it.each([
    ["audio/mpeg", "audio"],
    ["video/mp4", "video"],
  ])("renders and reports playback for %s", async (contentType, selector) => {
    const wrapper = mount(MediaPreview, {
      props: { media: media(contentType), source: "/media" },
    });

    await wrapper.get(selector).trigger("play");
    expect(wrapper.emitted("play")).toEqual([[]]);
  });
});
