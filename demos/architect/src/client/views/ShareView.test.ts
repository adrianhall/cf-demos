import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSharedViewerStore } from "../stores/shared-viewer";
import ShareView from "./ShareView.vue";

const stubs = {
  VProgressCircular: { template: "<div />" },
  VAlert: { template: '<div><slot name="title" /><slot /></div>' },
};

/** Wait for pending microtasks (the mounted resolve call) to settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mountView() {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const wrapper = mount(ShareView, {
    global: {
      plugins: [pinia],
      stubs: { ...stubs, DiagramCanvas: true },
    },
  });
  return { store: useSharedViewerStore(), wrapper };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("ShareView", () => {
  it("resolves the URL fragment's token on mount and renders the returned title", async () => {
    window.location.hash = "#raw-token-value";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          token: "raw-token-value",
        });
        return new Response(
          JSON.stringify({
            document: {
              version: 1,
              nodes: [],
              edges: [],
              viewport: { x: 0, y: 0, zoom: 1 },
            },
            revision: 2,
            title: "Published diagram",
          }),
          { status: 200 },
        );
      }),
    );
    const { wrapper } = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("Published diagram");
  });

  it("shows an error state without calling the resolve endpoint when no fragment is present", async () => {
    window.location.hash = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = mountView();
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("No share link was provided.");
  });

  it("shows a not-available message for an unknown or revoked token", async () => {
    window.location.hash = "#raw-token-value";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ detail: "This share link is not valid." }),
            { status: 404 },
          ),
        ),
    );
    const { wrapper } = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("This diagram is not available");
    expect(wrapper.text()).toContain("This share link is not valid.");
  });
});
