import { describe, expect, it } from "vitest";
import { applyReviewerProgress } from "./progress";
import type { ReviewerState } from "./types";

function reviewers(): ReviewerState[] {
  return [
    {
      role: "code-quality",
      status: "queued",
      costUsd: null,
      costSource: "pending",
      findingCount: 0,
    },
    {
      role: "accessibility",
      status: "queued",
      costUsd: null,
      costSource: "pending",
      findingCount: 0,
    },
    {
      role: "architecture",
      status: "queued",
      costUsd: null,
      costSource: "pending",
      findingCount: 0,
    },
    {
      role: "security",
      status: "queued",
      costUsd: null,
      costSource: "pending",
      findingCount: 0,
    },
  ];
}

describe("applyReviewerProgress", () => {
  it("sets status to running on reviewer_started, leaving other roles untouched", () => {
    const result = applyReviewerProgress(reviewers(), {
      role: "architecture",
      event: "reviewer_started",
    });

    expect(result.find((r) => r.role === "architecture")?.status).toBe(
      "running",
    );
    expect(result.find((r) => r.role === "security")?.status).toBe("queued");
  });

  it("sets status to done and findingCount on reviewer_completed", () => {
    const result = applyReviewerProgress(reviewers(), {
      role: "code-quality",
      event: "reviewer_completed",
      findingCount: 3,
    });

    expect(result.find((r) => r.role === "code-quality")).toMatchObject({
      status: "done",
      findingCount: 3,
    });
  });

  it("sets status to skipped on reviewer_skipped", () => {
    const result = applyReviewerProgress(reviewers(), {
      role: "accessibility",
      event: "reviewer_skipped",
      skippedReason: "No UI files",
    });

    expect(result.find((r) => r.role === "accessibility")?.status).toBe(
      "skipped",
    );
  });

  it("sets status to error on reviewer_failed", () => {
    const result = applyReviewerProgress(reviewers(), {
      role: "security",
      event: "reviewer_failed",
      errorDetail: "boom",
    });

    expect(result.find((r) => r.role === "security")?.status).toBe("error");
  });

  it("sets costUsd and costSource to gateway on cost_reconciled", () => {
    const result = applyReviewerProgress(reviewers(), {
      role: "architecture",
      event: "cost_reconciled",
      costUsd: 0.01,
    });

    expect(result.find((r) => r.role === "architecture")).toMatchObject({
      costUsd: 0.01,
      costSource: "gateway",
    });
  });

  it("does not mutate the input array", () => {
    const input = reviewers();
    const snapshot = JSON.stringify(input);

    applyReviewerProgress(input, {
      role: "security",
      event: "reviewer_started",
    });

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
