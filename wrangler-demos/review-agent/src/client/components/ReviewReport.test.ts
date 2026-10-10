import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { testVuetify } from "../test/vuetify";
import type { ReviewFinding } from "../stores/reviews";
import ReviewReport from "./ReviewReport.vue";

const findings: ReviewFinding[] = [
  {
    findingRef: "SEC-001",
    priority: "P0",
    severity: "critical",
    category: "Injection",
    filePath: "src/worker/routes/webhooks.ts",
    lineNumber: 42,
    finding: "Webhook signature comparison uses ===.",
    recommendation: "Use a timing-safe comparison.",
    mergedFrom: null,
  },
  {
    findingRef: "ARCH-002+",
    priority: "P1",
    severity: "high",
    category: "Coupling",
    filePath: null,
    lineNumber: null,
    finding: "The Agent duplicates pipeline logic.",
    recommendation: "Move it into the Workflow.",
    mergedFrom: "architecture,code-quality",
  },
];

describe("ReviewReport", () => {
  it("renders the severity summary and total across all four priorities", () => {
    const wrapper = mount(ReviewReport, {
      global: { plugins: [testVuetify] },
      props: { findings, fullReport: "# Report" },
    });

    expect(wrapper.text()).toContain("P0: 1");
    expect(wrapper.text()).toContain("P1: 1");
    expect(wrapper.text()).toContain("P2: 0");
    expect(wrapper.text()).toContain("P3: 0");
    expect(wrapper.text()).toContain("Total: 2");
  });

  it("renders every finding's row with its location and merged-from contributors", () => {
    const wrapper = mount(ReviewReport, {
      global: { plugins: [testVuetify] },
      props: { findings, fullReport: null },
    });

    expect(wrapper.text()).toContain("SEC-001");
    expect(wrapper.text()).toContain("src/worker/routes/webhooks.ts:42");
    expect(wrapper.text()).toContain("Webhook signature comparison uses ===.");
    expect(wrapper.text()).toContain("ARCH-002+");
    // A finding with no file/line renders a placeholder rather than an empty cell.
    expect(wrapper.text()).toContain("—");
  });

  it("shows just the file path when a finding has no line number", () => {
    const wrapper = mount(ReviewReport, {
      global: { plugins: [testVuetify] },
      props: {
        findings: [
          {
            ...findings[0],
            filePath: "README.md",
            lineNumber: null,
          } as (typeof findings)[0],
        ],
        fullReport: null,
      },
    });

    expect(wrapper.text()).toContain("README.md");
    expect(wrapper.text()).not.toContain("README.md:");
  });

  it("shows an honest 'no findings' message instead of an empty table", () => {
    const wrapper = mount(ReviewReport, {
      global: { plugins: [testVuetify] },
      props: { findings: [], fullReport: "# Report" },
    });

    expect(wrapper.text()).toContain(
      "No findings were reported by any reviewer.",
    );
    expect(wrapper.find("table.findings-table").exists()).toBe(false);
  });

  it("renders the full Markdown report, including a reviewer's collapsible raw output", () => {
    const wrapper = mount(ReviewReport, {
      global: { plugins: [testVuetify] },
      props: {
        findings: [],
        fullReport:
          "<details>\n<summary>Architecture (done)</summary>\n\nLooks fine overall.\n\n</details>",
      },
    });

    expect(wrapper.html()).toContain("<details>");
    expect(wrapper.text()).toContain("Architecture (done)");
    expect(wrapper.text()).toContain("Looks fine overall.");
  });

  it("shows a placeholder while the full report is not available yet", () => {
    const wrapper = mount(ReviewReport, {
      global: { plugins: [testVuetify] },
      props: { findings: [], fullReport: null },
    });

    expect(wrapper.text()).toContain("The full report is not available yet.");
  });
});
