import { createTestingPinia } from "@pinia/testing";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { useReviewsStore } from "../stores/reviews";
import HomeView from "./HomeView.vue";

const stubs = {
  ReviewHistoryList: {
    name: "ReviewHistoryList",
    props: ["error", "loading", "page", "pageSize", "runs", "total"],
    template: '<div data-testid="history-list" />',
  },
  ReviewTriggerForm: {
    name: "ReviewTriggerForm",
    template: '<div data-testid="trigger-form" />',
  },
};

describe("HomeView", () => {
  it("loads the first page of history on mount", async () => {
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: true });
    const store = useReviewsStore(pinia);
    mount(HomeView, { global: { plugins: [pinia], stubs } });
    await flushPromises();

    expect(store.loadHistory).toHaveBeenCalledWith(1);
  });

  it("requests a different page when the history list emits update:page", async () => {
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: true });
    const store = useReviewsStore(pinia);
    const wrapper = mount(HomeView, { global: { plugins: [pinia], stubs } });
    await flushPromises();
    vi.mocked(store.loadHistory).mockClear();

    await wrapper
      .getComponent({ name: "ReviewHistoryList" })
      .vm.$emit("update:page", 3);

    expect(store.loadHistory).toHaveBeenCalledWith(3);
  });

  it("renders both the trigger form and the history list", () => {
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: true });
    const wrapper = mount(HomeView, { global: { plugins: [pinia], stubs } });

    expect(wrapper.find('[data-testid="trigger-form"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="history-list"]').exists()).toBe(true);
  });
});
