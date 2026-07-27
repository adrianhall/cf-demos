import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import LibraryView from "./LibraryView.vue";

/** Minimal Vuetify and media-card stubs for testing the library grid behavior. */
const stubs = {
  VAlert: { name: "VAlert", template: "<div><slot /></div>" },
  "v-btn": { template: "<button><slot /></button>" },
  "v-card": { template: "<section><slot /></section>" },
  "v-card-text": { template: "<div><slot /></div>" },
  "v-col": { template: "<div><slot /></div>" },
  "v-container": { template: "<main><slot /></main>" },
  VProgressLinear: {
    name: "VProgressLinear",
    template: '<div class="loading" />',
  },
  "v-row": { template: "<div><slot /></div>" },
  MediaCard: {
    props: ["media"],
    template: "<article>{{ media.title }}</article>",
  },
};

describe("LibraryView", () => {
  it("renders every published item from the public library store", () => {
    const wrapper = mount(LibraryView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              library: {
                error: "",
                loading: false,
                media: [
                  {
                    contentType: "image/png",
                    createdAt: "2026-07-27T12:00:00.000Z",
                    id: "adf5b4e7-ae77-49d0-a9ee-d11aedf38d65",
                    publishedAt: "2026-07-27T12:00:00.000Z",
                    sizeBytes: 12,
                    status: "published",
                    title: "Published image",
                    updatedAt: "2026-07-27T12:00:00.000Z",
                  },
                ],
              },
            },
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("Published image");
    expect(wrapper.text()).not.toContain("The library is waiting");
  });

  it("renders loading, error, and empty-library states", () => {
    const mountWithState = (state: {
      error: string;
      loading: boolean;
      media: unknown[];
    }) =>
      mount(LibraryView, {
        global: {
          plugins: [
            createTestingPinia({
              createSpy: vi.fn,
              initialState: { library: state },
            }),
          ],
          stubs,
        },
      });

    expect(
      mountWithState({
        error: "Unable to load",
        loading: false,
        media: [],
      }).text(),
    ).toContain("Unable to load");
    expect(
      mountWithState({ error: "", loading: true, media: [] })
        .find(".loading")
        .exists(),
    ).toBe(true);
    expect(
      mountWithState({ error: "", loading: false, media: [] }).text(),
    ).toContain("The library is waiting for its first release.");
  });
});
