import { describe, expect, it } from "vitest";
import type { MergedFinding } from "./merge";
import type { ReviewerReportMeta } from "./report";
import { buildCommentBody, buildFullReport } from "./report";

const RUN = {
  id: "run-1",
  provider: "github" as const,
  repoFullName: "octo-org/octo-repo",
  prNumber: 42,
  prTitle: "Add a feature",
};

function mergedFinding(overrides: Partial<MergedFinding>): MergedFinding {
  return {
    findingRef: "ARCH-001",
    priority: "P1",
    severity: "high",
    category: "API design",
    filePath: "src/index.ts",
    lineNumber: 10,
    finding: "Something is wrong",
    recommendation: "Fix it",
    mergedFrom: null,
    role: "architecture",
    ...overrides,
  };
}

const REVIEWERS: ReviewerReportMeta[] = [
  {
    role: "architecture",
    model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    status: "done",
    skippedReason: null,
    errorDetail: null,
    rawOutput: "Architecture review prose.",
  },
  {
    role: "accessibility",
    model: null,
    status: "skipped",
    skippedReason: "No changed file has a UI-relevant extension.",
    errorDetail: null,
    rawOutput: null,
  },
];

describe("buildFullReport", () => {
  it("labels a GitLab run as an MR, not a PR", () => {
    const report = buildFullReport(
      { ...RUN, provider: "gitlab" },
      [],
      REVIEWERS,
    );

    expect(report).toContain('MR #42 ("Add a feature")');
  });

  it("includes the executive summary, severity table, findings table, and reviewer sections", () => {
    const findings = [mergedFinding({})];
    const report = buildFullReport(RUN, findings, REVIEWERS);

    expect(report).toContain("# PR Review Report: octo-org/octo-repo #42");
    expect(report).toContain("1 finding(s) total");
    expect(report).toContain("| P1 | 1 |");
    expect(report).toContain("ARCH-001");
    expect(report).toContain("<summary>Architecture (done, @cf/deepseek");
    expect(report).toContain("Architecture review prose.");
    expect(report).toContain("<summary>Accessibility (skipped)</summary>");
    expect(report).toContain("No changed file has a UI-relevant extension.");
  });

  it("reports a short, honest message when there are no findings, not an empty table", () => {
    const report = buildFullReport(RUN, [], REVIEWERS);

    expect(report).toContain("No findings were reported by any reviewer");
    expect(report).not.toContain("| Priority | Ref |");
  });

  it("shows an error reviewer's error detail instead of raw output", () => {
    const reviewers: ReviewerReportMeta[] = [
      {
        role: "security",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        status: "error",
        skippedReason: null,
        errorDetail: "Model output could not be parsed as valid JSON",
        rawOutput: null,
      },
    ];

    const report = buildFullReport(RUN, [], reviewers);

    expect(report).toContain(
      "This reviewer failed: Model output could not be parsed",
    );
  });

  it("falls back to a generic message when an error reviewer has no errorDetail", () => {
    const reviewers: ReviewerReportMeta[] = [
      {
        role: "security",
        model: null,
        status: "error",
        skippedReason: null,
        errorDetail: null,
        rawOutput: null,
      },
    ];

    expect(buildFullReport(RUN, [], reviewers)).toContain(
      "This reviewer failed: unknown error",
    );
  });

  it("falls back to a generic message when a done reviewer somehow has no rawOutput", () => {
    const reviewers: ReviewerReportMeta[] = [
      {
        role: "code-quality",
        model: null,
        status: "done",
        skippedReason: null,
        errorDetail: null,
        rawOutput: null,
      },
    ];

    expect(buildFullReport(RUN, [], reviewers)).toContain(
      "_No output recorded._",
    );
  });

  it("falls back to a generic message when a skipped reviewer has no skippedReason", () => {
    const reviewers: ReviewerReportMeta[] = [
      {
        role: "accessibility",
        model: null,
        status: "skipped",
        skippedReason: null,
        errorDetail: null,
        rawOutput: null,
      },
    ];

    expect(buildFullReport(RUN, [], reviewers)).toContain("Skipped.");
  });
});

describe("buildCommentBody", () => {
  it("includes only P0/P1 findings and a '+N more' note when P2/P3 findings exist", () => {
    const findings = [
      mergedFinding({ findingRef: "SEC-001", priority: "P0" }),
      mergedFinding({ findingRef: "ARCH-002", priority: "P1" }),
      mergedFinding({ findingRef: "CODE-001", priority: "P2" }),
      mergedFinding({ findingRef: "A11Y-001", priority: "P3" }),
    ];

    const comment = buildCommentBody(
      RUN,
      findings,
      "https://review-agent.cfapps.uk",
    );

    expect(comment).toContain("SEC-001");
    expect(comment).toContain("ARCH-002");
    expect(comment).not.toContain("CODE-001");
    expect(comment).not.toContain("A11Y-001");
    expect(comment).toContain("+2 more finding(s)");
    expect(comment).toContain(
      "[View the full report](https://review-agent.cfapps.uk/reviews/run-1)",
    );
  });

  it("omits the '+N more' note when every finding is P0/P1", () => {
    const findings = [mergedFinding({ priority: "P0" })];

    const comment = buildCommentBody(
      RUN,
      findings,
      "https://review-agent.cfapps.uk",
    );

    expect(comment).not.toContain("more finding(s)");
  });

  it("builds the report URL from the passed-in base, not a hardcoded hostname", () => {
    const comment = buildCommentBody(RUN, [], "http://localhost:8787");

    expect(comment).toContain(
      "[View the full report](http://localhost:8787/reviews/run-1)",
    );
  });

  it("posts a short, honest 'no findings' message rather than an empty table", () => {
    const comment = buildCommentBody(RUN, [], "https://review-agent.cfapps.uk");

    expect(comment).toContain("No findings were reported by any reviewer");
    expect(comment).not.toContain("| Priority | Count |");
  });

  it("says so plainly when every finding is P2/P3 (no P0/P1 rows at all)", () => {
    const findings = [mergedFinding({ priority: "P2" })];

    const comment = buildCommentBody(
      RUN,
      findings,
      "https://review-agent.cfapps.uk",
    );

    expect(comment).toContain(
      "No P0/P1 findings -- see the full report for lower-priority findings.",
    );
  });
});
