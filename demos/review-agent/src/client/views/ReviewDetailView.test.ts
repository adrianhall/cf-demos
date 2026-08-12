import { createTestingPinia } from "@pinia/testing";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import type {
  ReviewRunConnectionStatus,
  ReviewRunEvent,
} from "../composables/useReviewRun";
import { type ReviewRunDetail, useReviewsStore } from "../stores/reviews";
import { testVuetify } from "../test/vuetify";
import ReviewDetailView from "./ReviewDetailView.vue";

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "run-1" } }),
}));

const useReviewRunMock = vi.fn();
vi.mock("../composables/useReviewRun", () => ({
  useReviewRun: (...args: unknown[]) => useReviewRunMock(...args),
}));

/** A controllable stand-in for `useReviewRun`'s return value -- lets a test push a fresh event
 * or patch `state` and observe the view react, without opening a real WebSocket
 * (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 7, item 28: "the run detail page's
 * badge states fed a synthetic `useReviewRun` stream"). */
function useSyntheticReviewRun() {
  const state = shallowRef<Record<string, unknown> | null>(null);
  const connectionStatus = shallowRef<ReviewRunConnectionStatus>("connected");
  const events = shallowRef<readonly ReviewRunEvent[]>([]);
  useReviewRunMock.mockReturnValue({ state, connectionStatus, events });
  return { state, connectionStatus, events };
}

function detailFixture(
  overrides: Partial<ReviewRunDetail["run"]> = {},
): ReviewRunDetail {
  return {
    run: {
      id: "run-1",
      provider: "github",
      repoFullName: "octo/widgets",
      prNumber: 7,
      prTitle: "Add dark mode",
      status: "running",
      totalCostUsd: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      completedAt: null,
      workflowInstanceId: "wf-1",
      prUrl: "https://github.com/octo/widgets/pull/7",
      prAuthor: "octocat",
      headSha: "abc123",
      trigger: "manual",
      triggeredByEmail: "reviewer@example.com",
      diffTruncated: false,
      changedFileCount: 2,
      commentUrl: null,
      errorDetail: null,
      fullReport: null,
      ...overrides,
    },
    reviewers: [
      {
        role: "code-quality",
        model: "@cf/ibm-granite/granite-4.0-h-micro",
        status: "running",
        skippedReason: null,
        errorDetail: null,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        costSource: "pending",
        findingCount: 0,
      },
      {
        role: "accessibility",
        model: null,
        status: "skipped",
        skippedReason: "No changed file has a UI-relevant extension.",
        errorDetail: null,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        costSource: "pending",
        findingCount: 0,
      },
      {
        role: "architecture",
        model: null,
        status: "queued",
        skippedReason: null,
        errorDetail: null,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        costSource: "pending",
        findingCount: 0,
      },
      {
        role: "security",
        model: null,
        status: "queued",
        skippedReason: null,
        errorDetail: null,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        costSource: "pending",
        findingCount: 0,
      },
    ],
    findings: [],
  };
}

/** Mount the view with a testing Pinia `reviews` store pre-seeded with `detail`/`detailError`,
 * returning the store itself too so a test can further mutate it (mirroring a real
 * `loadDetail()` REST response landing). */
function mountView(
  detail: ReviewRunDetail | null,
  detailError: string | null = null,
) {
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    initialState: {
      reviews: { detail, detailError, detailLoading: false },
    },
    stubActions: true,
  });
  const store = useReviewsStore(pinia);
  const wrapper = mount(ReviewDetailView, {
    global: { plugins: [pinia, testVuetify] },
  });
  return { store, wrapper };
}

describe("ReviewDetailView", () => {
  beforeEach(() => {
    useReviewRunMock.mockReset();
  });

  it("shows a not-found state for a nonexistent run instead of a blank page", async () => {
    useSyntheticReviewRun();
    const { wrapper } = mountView(null, "No review run found with id run-1.");
    await flushPromises();

    expect(wrapper.text()).toContain("Run not found");
    expect(wrapper.text()).toContain("No review run found with id run-1.");
    expect(wrapper.find(".reviewer-badges").exists()).toBe(false);
  });

  it("shows why accessibility was skipped, sourced from the REST detail", async () => {
    useSyntheticReviewRun();
    const { wrapper } = mountView(detailFixture());
    await flushPromises();

    expect(wrapper.text()).toContain(
      "No changed file has a UI-relevant extension.",
    );
  });

  it("prefers the live connection's status once it hydrates", async () => {
    const { state } = useSyntheticReviewRun();
    const { wrapper } = mountView(detailFixture());
    await flushPromises();
    expect(wrapper.text()).toContain("Running");

    state.value = {
      runId: "run-1",
      workflowInstanceId: "wf-1",
      status: "completed",
      reviewers: [],
    };
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("Completed");
  });

  it("reflects a reviewer_failed transition: badge status, error detail, and the live-region announcement", async () => {
    const { state, events } = useSyntheticReviewRun();
    const { store, wrapper } = mountView(detailFixture());
    await flushPromises();

    state.value = {
      runId: "run-1",
      workflowInstanceId: "wf-1",
      status: "running",
      reviewers: [
        {
          role: "code-quality",
          status: "error",
          costUsd: null,
          costSource: "pending",
          findingCount: 0,
        },
      ],
    };
    // Live `state` never carries `errorDetail` (see `ReviewDetailView.vue`'s own
    // `reviewerViewModels` doc comment) -- a real page would get it from a REST reload, so this
    // test updates the store's own `detail` the same way `loadDetail()` would.
    store.detail = {
      ...detailFixture(),
      reviewers: detailFixture().reviewers.map((reviewer) =>
        reviewer.role === "code-quality"
          ? {
              ...reviewer,
              status: "error" as const,
              errorDetail: "The model timed out.",
            }
          : reviewer,
      ),
    };
    events.value = [
      {
        type: "reviewer_failed",
        role: "code-quality",
        errorDetail: "The model timed out.",
        receivedAt: Date.now(),
      },
    ];
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("Failed");
    expect(wrapper.text()).toContain("The model timed out.");
    expect(wrapper.get('[role="status"]').text()).toBe(
      "Code Quality review failed: The model timed out.",
    );
  });

  it("reflects a cost_reconciled transition: confirmed cost and the live-region announcement", async () => {
    const { state, events } = useSyntheticReviewRun();
    const { wrapper } = mountView(detailFixture());
    await flushPromises();

    state.value = {
      runId: "run-1",
      workflowInstanceId: "wf-1",
      status: "running",
      reviewers: [
        {
          role: "code-quality",
          status: "done",
          costUsd: 0.0031,
          costSource: "gateway",
          findingCount: 2,
        },
      ],
    };
    events.value = [
      {
        type: "cost_reconciled",
        role: "code-quality",
        costUsd: 0.0031,
        receivedAt: Date.now(),
      },
    ];
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("$0.0031 (AI Gateway)");
    expect(wrapper.get('[role="status"]').text()).toBe(
      "Code Quality cost confirmed by AI Gateway.",
    );
  });

  it("renders the full report only once the run has completed", async () => {
    useSyntheticReviewRun();
    const running = mountView(
      detailFixture({ status: "running", fullReport: null }),
    );
    await flushPromises();
    expect(running.wrapper.find(".review-report").exists()).toBe(false);

    const completed = mountView(
      detailFixture({
        status: "completed",
        fullReport: "# Report",
        completedAt: "2026-08-01T00:10:00.000Z",
      }),
    );
    await flushPromises();
    expect(completed.wrapper.find(".review-report").exists()).toBe(true);
  });

  it("shows the posted comment link once available", async () => {
    useSyntheticReviewRun();
    const { wrapper } = mountView(
      detailFixture({
        status: "completed",
        commentUrl: "https://github.com/octo/widgets/pull/7#comment",
      }),
    );
    await flushPromises();

    expect(
      wrapper
        .get('a[href="https://github.com/octo/widgets/pull/7#comment"]')
        .text(),
    ).toBe("View the posted comment");
  });

  it("shows a failed run's own error detail", async () => {
    useSyntheticReviewRun();
    const { wrapper } = mountView(
      detailFixture({
        status: "failed",
        errorDetail: "fetch-diff exhausted its retries.",
      }),
    );
    await flushPromises();

    expect(wrapper.text()).toContain("fetch-diff exhausted its retries.");
  });

  it("shows a connecting notice while the live connection is still opening", async () => {
    const synthetic = useSyntheticReviewRun();
    synthetic.connectionStatus.value = "connecting";
    const { wrapper } = mountView(detailFixture());
    await flushPromises();

    expect(wrapper.text()).toContain("Connecting to live updates");
  });

  it("shows an error notice when the live connection fails", async () => {
    const synthetic = useSyntheticReviewRun();
    synthetic.connectionStatus.value = "error";
    const { wrapper } = mountView(detailFixture());
    await flushPromises();

    expect(wrapper.text()).toContain("Live updates are unavailable");
  });

  it.each([
    [
      { type: "reviewer_started", role: "code-quality", receivedAt: 1 },
      "Code Quality review started.",
    ],
    [
      {
        type: "reviewer_skipped",
        role: "accessibility",
        skippedReason: "No changed file has a UI-relevant extension.",
        receivedAt: 1,
      },
      "Accessibility review skipped: No changed file has a UI-relevant extension.",
    ],
    [
      {
        type: "reviewer_completed",
        role: "code-quality",
        findingCount: 1,
        receivedAt: 1,
      },
      "Code Quality review completed with 1 finding.",
    ],
    [
      {
        type: "reviewer_completed",
        role: "code-quality",
        findingCount: 3,
        receivedAt: 1,
      },
      "Code Quality review completed with 3 findings.",
    ],
    [
      { type: "review_completed", commentUrl: null, receivedAt: 1 },
      "Review completed.",
    ],
    [
      { type: "review_failed", detail: "boom", receivedAt: 1 },
      "Review failed: boom",
    ],
  ] as const)(
    "announces a %o transition in the shared live region",
    async (event, expected) => {
      const { events } = useSyntheticReviewRun();
      const { wrapper } = mountView(detailFixture());
      await flushPromises();

      events.value = [event];
      await wrapper.vm.$nextTick();

      expect(wrapper.get('[role="status"]').text()).toBe(expected);
    },
  );
});
