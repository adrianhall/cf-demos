import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { MediaItem } from "../media";
import MediaCard from "./MediaCard.vue";

/** Draft media supplied to studio action tests. */
const draft: MediaItem = {
  contentType: "image/png",
  createdAt: "2026-07-27T12:00:00.000Z",
  id: "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
  publishedAt: null,
  sizeBytes: 12,
  status: "draft",
  title: "Private image",
  updatedAt: "2026-07-27T12:00:00.000Z",
};

/** Minimal Vuetify stubs that preserve button click behavior. */
const stubs = {
  "v-btn": { template: "<button><slot /></button>" },
  "v-card": { template: "<section><slot /></section>" },
  "v-card-actions": { template: "<div><slot /></div>" },
  "v-card-item": {
    template:
      '<div><slot /><slot name="title" /><slot name="subtitle" /><slot name="append" /></div>',
  },
  "v-chip": { template: "<span><slot /></span>" },
  "v-spacer": { template: "<span />" },
  MediaPreview: { emits: ["play"], name: "MediaPreview", template: "<div />" },
};

describe("MediaCard", () => {
  it("emits publish and delete requests for a studio draft", async () => {
    const wrapper = mount(MediaCard, {
      global: { stubs },
      props: {
        media: draft,
        source: "/api/studio/media/draft/content",
        studio: true,
      },
    });

    await wrapper.get('[aria-label="Publish Private image"]').trigger("click");
    await wrapper.get('[aria-label="Delete Private image"]').trigger("click");

    expect(wrapper.emitted("publish")).toEqual([[draft.id]]);
    expect(wrapper.emitted("remove")).toEqual([[draft]]);
  });

  it("shows published detail navigation and forwards playback", async () => {
    const wrapper = mount(MediaCard, {
      global: { stubs },
      props: {
        detailTo: "/media/published",
        media: { ...draft, status: "published" },
        source: "/api/library/media/published/content",
        studio: true,
      },
    });

    await wrapper.getComponent({ name: "MediaPreview" }).vm.$emit("play");
    expect(
      wrapper.find('[aria-label="View details for Private image"]').exists(),
    ).toBe(true);
    expect(wrapper.text()).toContain("published");
    expect(wrapper.emitted("play")).toEqual([[draft.id]]);
  });
});
