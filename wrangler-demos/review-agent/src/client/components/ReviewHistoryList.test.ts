import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { testVuetify } from "../test/vuetify";
import type { ReviewRunSummary } from "../stores/reviews";
import ReviewHistoryList from "./ReviewHistoryList.vue";

const stubs = {
  RouterLink: {
    props: ["to"],
    template: '<a :href="to"><slot /></a>',
  },
};

const exampleRun: ReviewRunSummary = {
  id: "run-1",
  provider: "github",
  repoFullName: "octo/widgets",
  prNumber: 42,
  prTitle: "Add dark mode",
  status: "completed",
  totalCostUsd: 0.0123,
  createdAt: "2026-08-01T00:00:00.000Z",
  completedAt: "2026-08-01T00:05:00.000Z",
};

function mountList(
  props: Partial<InstanceType<typeof ReviewHistoryList>["$props"]> = {},
) {
  return mount(ReviewHistoryList, {
    global: { plugins: [testVuetify], stubs },
    props: {
      error: null,
      loading: false,
      page: 1,
      pageSize: 20,
      runs: [],
      total: 0,
      ...props,
    },
  });
}

describe("ReviewHistoryList", () => {
  it("shows an empty-state message when there are no runs", () => {
    const wrapper = mountList();

    expect(wrapper.text()).toContain("No reviews yet");
  });

  it("shows a loading message on the very first load", () => {
    const wrapper = mountList({ loading: true });

    expect(wrapper.text()).toContain("Loading review history");
  });

  it("shows a load failure message", () => {
    const wrapper = mountList({ error: "Could not load review history." });

    expect(wrapper.text()).toContain("Could not load review history.");
  });

  it.each([
    ["running", "Running"],
    ["completed", "Completed"],
    ["failed", "Failed"],
  ] as const)(
    "renders a %s run with its own status label and a link to its detail page",
    (status, label) => {
      const wrapper = mountList({
        runs: [{ ...exampleRun, status }],
        total: 1,
      });

      expect(wrapper.text()).toContain("octo/widgets");
      expect(wrapper.text()).toContain("PR #42: Add dark mode");
      expect(wrapper.text()).toContain(label);
      expect(wrapper.find('a[href="/reviews/run-1"]').exists()).toBe(true);
    },
  );

  it("labels a GitLab run's request as an MR rather than a PR", () => {
    const wrapper = mountList({
      runs: [{ ...exampleRun, provider: "gitlab" }],
      total: 1,
    });

    expect(wrapper.text()).toContain("MR #42");
  });

  it("shows pending for a run with no confirmed cost yet", () => {
    const wrapper = mountList({
      runs: [{ ...exampleRun, totalCostUsd: null }],
      total: 1,
    });

    expect(wrapper.text()).toContain("Pending");
  });

  it("shows the pagination control only when there is more than one page", () => {
    const singlePage = mountList({
      runs: [exampleRun],
      total: 1,
      pageSize: 20,
    });
    expect(singlePage.findComponent({ name: "VPagination" }).exists()).toBe(
      false,
    );

    const multiplePages = mountList({
      runs: [exampleRun],
      total: 42,
      pageSize: 20,
    });
    expect(multiplePages.findComponent({ name: "VPagination" }).exists()).toBe(
      true,
    );
  });

  it("emits update:page when a different page is selected", async () => {
    const wrapper = mountList({ runs: [exampleRun], total: 42, pageSize: 20 });

    await wrapper
      .findComponent({ name: "VPagination" })
      .vm.$emit("update:modelValue", 2);

    expect(wrapper.emitted("update:page")).toEqual([[2]]);
  });
});
