import { createTestingPinia } from "@pinia/testing";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testVuetify } from "../test/vuetify";
import ReviewTriggerForm from "./ReviewTriggerForm.vue";

const push = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));

/** Mount the trigger form with a spyable `reviews` store. */
function mountForm() {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: true });
  return {
    pinia,
    wrapper: mount(ReviewTriggerForm, {
      global: { plugins: [pinia, testVuetify] },
    }),
  };
}

describe("ReviewTriggerForm", () => {
  afterEach(() => {
    push.mockClear();
  });

  it("shows a validation error and never submits when the field is empty", async () => {
    const { pinia, wrapper } = mountForm();
    const { useReviewsStore } = await import("../stores/reviews");
    const store = useReviewsStore(pinia);

    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain(
      "Enter a pull request or merge request URL.",
    );
    expect(store.triggerReview).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a validation error and never submits for a malformed URL", async () => {
    const { pinia, wrapper } = mountForm();
    const { useReviewsStore } = await import("../stores/reviews");
    const store = useReviewsStore(pinia);

    await wrapper.get("input").setValue("not a url");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("Enter a valid web address");
    expect(store.triggerReview).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it.each([
    ["a GitHub pull request URL", "https://github.com/owner/repo/pull/123"],
    [
      "a GitLab merge request URL",
      "https://gitlab.com/group/project/-/merge_requests/45",
    ],
  ])(
    "submits %s and navigates to the new run's detail page",
    async (_label, url) => {
      const { pinia, wrapper } = mountForm();
      const { useReviewsStore } = await import("../stores/reviews");
      const store = useReviewsStore(pinia);
      vi.mocked(store.triggerReview).mockResolvedValue("run-123");

      await wrapper.get("input").setValue(url);
      await wrapper.get("form").trigger("submit");
      await flushPromises();

      expect(store.triggerReview).toHaveBeenCalledWith(url);
      expect(push).toHaveBeenCalledWith("/reviews/run-123");
      expect((wrapper.get("input").element as HTMLInputElement).value).toBe("");
    },
  );

  it("shows the server's own rejection message inline and never navigates", async () => {
    const { pinia, wrapper } = mountForm();
    const { useReviewsStore } = await import("../stores/reviews");
    const store = useReviewsStore(pinia);
    vi.mocked(store.triggerReview).mockRejectedValue(
      new Error("Could not read this PR/MR from the provider."),
    );

    await wrapper.get("input").setValue("https://github.com/owner/repo/pull/1");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain(
      "Could not read this PR/MR from the provider.",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a safe fallback message when the store rejects a non-Error value", async () => {
    const { pinia, wrapper } = mountForm();
    const { useReviewsStore } = await import("../stores/reviews");
    const store = useReviewsStore(pinia);
    vi.mocked(store.triggerReview).mockRejectedValue("offline");

    await wrapper.get("input").setValue("https://github.com/owner/repo/pull/1");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("Could not start this review.");
  });

  it("disables the field and submit button while submitting", async () => {
    const { pinia, wrapper } = mountForm();
    const { useReviewsStore } = await import("../stores/reviews");
    const store = useReviewsStore(pinia);
    let resolveTrigger: (value: string) => void = () => {};
    vi.mocked(store.triggerReview).mockImplementation(
      () => new Promise((resolve) => (resolveTrigger = resolve)),
    );

    await wrapper.get("input").setValue("https://github.com/owner/repo/pull/1");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect((wrapper.get("input").element as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      (wrapper.get("button[type='submit']").element as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    resolveTrigger("run-1");
    await flushPromises();
  });
});
