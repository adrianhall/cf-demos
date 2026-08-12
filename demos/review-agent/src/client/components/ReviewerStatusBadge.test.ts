import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { ReviewRunEvent } from "../composables/useReviewRun";
import { testVuetify } from "../test/vuetify";
import ReviewerStatusBadge from "./ReviewerStatusBadge.vue";

describe("ReviewerStatusBadge", () => {
  it("shows the role label and queued status with no cost line", () => {
    const wrapper = mount(ReviewerStatusBadge, {
      global: { plugins: [testVuetify] },
      props: {
        costSource: "pending",
        costUsd: null,
        errorDetail: null,
        findingCount: 0,
        role: "code-quality",
        skippedReason: null,
        status: "queued",
      },
    });

    expect(wrapper.text()).toContain("Code Quality");
    expect(wrapper.text()).toContain("Queued");
    expect(wrapper.text()).not.toContain("Pending");
  });

  it("shows why accessibility was skipped, not just its absence", () => {
    const wrapper = mount(ReviewerStatusBadge, {
      global: { plugins: [testVuetify] },
      props: {
        costSource: "pending",
        costUsd: null,
        errorDetail: null,
        findingCount: 0,
        role: "accessibility",
        skippedReason: "No changed file has a UI-relevant extension.",
        status: "skipped",
      },
    });

    expect(wrapper.text()).toContain("Skipped");
    expect(wrapper.text()).toContain(
      "No changed file has a UI-relevant extension.",
    );
  });

  it("shows the error detail for a failed reviewer", () => {
    const wrapper = mount(ReviewerStatusBadge, {
      global: { plugins: [testVuetify] },
      props: {
        costSource: "pending",
        costUsd: null,
        errorDetail: "The model's JSON output was invalid twice.",
        findingCount: 0,
        role: "security",
        skippedReason: null,
        status: "error",
      },
    });

    expect(wrapper.text()).toContain("Failed");
    expect(wrapper.text()).toContain(
      "The model's JSON output was invalid twice.",
    );
  });

  it("shows the finding count and a pending cost for a done reviewer", () => {
    const wrapper = mount(ReviewerStatusBadge, {
      global: { plugins: [testVuetify] },
      props: {
        costSource: "pending",
        costUsd: null,
        errorDetail: null,
        findingCount: 3,
        role: "architecture",
        skippedReason: null,
        status: "done",
      },
    });

    expect(wrapper.text()).toContain("3 findings");
    expect(wrapper.text()).toContain("Pending");
  });

  it("shows the AI-Gateway-confirmed cost once reconciled", () => {
    const wrapper = mount(ReviewerStatusBadge, {
      global: { plugins: [testVuetify] },
      props: {
        costSource: "gateway",
        costUsd: 0.0042,
        errorDetail: null,
        findingCount: 1,
        role: "architecture",
        skippedReason: null,
        status: "done",
      },
    });

    expect(wrapper.text()).toContain("$0.0042");
    expect(wrapper.text()).toContain("AI Gateway");
  });

  it("flashes when a fresh event for this reviewer's own role arrives", async () => {
    vi.useFakeTimers();
    const events: ReviewRunEvent[] = [];
    const wrapper = mount(ReviewerStatusBadge, {
      global: { plugins: [testVuetify] },
      props: {
        costSource: "pending",
        costUsd: null,
        errorDetail: null,
        events,
        findingCount: 0,
        role: "code-quality",
        skippedReason: null,
        status: "running",
      },
    });
    expect(wrapper.find(".flashing").exists()).toBe(false);

    await wrapper.setProps({
      events: [
        {
          type: "reviewer_completed",
          role: "code-quality",
          findingCount: 2,
          receivedAt: Date.now(),
        },
      ],
    });

    expect(wrapper.find(".flashing").exists()).toBe(true);
    vi.advanceTimersByTime(1_300);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".flashing").exists()).toBe(false);
    vi.useRealTimers();
  });

  it("restarts the flash timer when a second own-role event arrives mid-flash", async () => {
    vi.useFakeTimers();
    const wrapper = mount(ReviewerStatusBadge, {
      global: { plugins: [testVuetify] },
      props: {
        costSource: "pending",
        costUsd: null,
        errorDetail: null,
        events: [],
        findingCount: 0,
        role: "code-quality",
        skippedReason: null,
        status: "running",
      },
    });

    await wrapper.setProps({
      events: [
        { type: "reviewer_started", role: "code-quality", receivedAt: 1 },
      ],
    });
    expect(wrapper.find(".flashing").exists()).toBe(true);

    // A second event for the same role arrives before the first flash finished -- the timer
    // must restart rather than clearing the flash early.
    vi.advanceTimersByTime(600);
    await wrapper.setProps({
      events: [
        { type: "reviewer_started", role: "code-quality", receivedAt: 1 },
        { type: "reviewer_completed", role: "code-quality", receivedAt: 2 },
      ],
    });
    vi.advanceTimersByTime(600);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".flashing").exists()).toBe(true);

    vi.advanceTimersByTime(700);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".flashing").exists()).toBe(false);
    vi.useRealTimers();
  });

  it("does not flash for a different reviewer's event", async () => {
    const wrapper = mount(ReviewerStatusBadge, {
      global: { plugins: [testVuetify] },
      props: {
        costSource: "pending",
        costUsd: null,
        errorDetail: null,
        events: [],
        findingCount: 0,
        role: "code-quality",
        skippedReason: null,
        status: "running",
      },
    });

    await wrapper.setProps({
      events: [
        {
          type: "reviewer_completed",
          role: "security",
          findingCount: 1,
          receivedAt: Date.now(),
        },
      ],
    });

    expect(wrapper.find(".flashing").exists()).toBe(false);
  });
});
