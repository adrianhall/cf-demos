<script setup lang="ts">
import { computed } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { PRIORITY_COLORS } from "../lib/format";
import type { FindingPriority, ReviewFinding } from "../stores/reviews";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import MarkdownView from "./MarkdownView.vue";

/**
 * A completed run's full report (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 6, item
 * 25: "the full report (executive summary, severity table, findings table, each reviewer's raw
 * output in a collapsible panel)"). Renders the severity summary and findings table natively
 * from the structured `findings` array (semantic `<table>`, real `<th scope>` headers, chips
 * labeled with text as well as color) rather than solely from `fullReport`'s own Markdown
 * tables, for full control over accessible markup -- then renders `fullReport` itself
 * (`MarkdownView.vue`) underneath for the parts that structured `findings` data alone cannot
 * reproduce: each reviewer's own raw prose output under a collapsible `<details>` section.
 * `GET /api/reviews/:id`'s `ReviewerDetail` response shape deliberately excludes each reviewer's
 * raw output (`../../worker/data/reviewRuns.ts`'s `countReviewerFindings()` doc comment explains
 * why) -- `fullReport`'s own embedded `<details>` sections are the only place that text is
 * available to the client at all, so this component renders both representations rather than
 * picking one over the other.
 */
interface Props {
  /** The run's complete merged findings list. */
  findings: readonly ReviewFinding[];
  /** The run's full canonical Markdown report, or `null` before the run completes. */
  fullReport: string | null;
}

const props = defineProps<Props>();

const PRIORITIES: readonly FindingPriority[] = ["P0", "P1", "P2", "P3"];

/** Findings-by-priority counts, always all four keys (zero-filled) -- mirrors
 * `../../worker/review/report.ts`'s own `countByPriority()`. */
const priorityCounts = computed<Record<FindingPriority, number>>(() => {
  const counts: Record<FindingPriority, number> = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
  for (const finding of props.findings) {
    counts[finding.priority] += 1;
  }
  return counts;
});

/** A finding's file/line location, or a placeholder when neither is known. */
function locationLabel(finding: ReviewFinding): string {
  if (finding.filePath === null) {
    return "—";
  }
  return finding.lineNumber === null
    ? finding.filePath
    : `${finding.filePath}:${finding.lineNumber}`;
}
</script>

<template>
  <section aria-labelledby="report-heading" class="review-report">
    <h2 id="report-heading">Full Report</h2>

    <h3 id="severity-heading">Severity Summary</h3>
    <ul
      aria-labelledby="severity-heading"
      class="severity-summary"
      role="list"
    >
      <li v-for="priority in PRIORITIES" :key="priority">
        <v-chip :color="PRIORITY_COLORS[priority]" size="small">
          {{ priority }}: {{ priorityCounts[priority] }}
        </v-chip>
      </li>
      <li>
        <strong>Total: {{ findings.length }}</strong>
      </li>
    </ul>

    <h3 id="findings-heading">Findings</h3>
    <p v-if="findings.length === 0">
      No findings were reported by any reviewer.
    </p>
    <table v-else aria-labelledby="findings-heading" class="findings-table">
      <caption class="sr-only">Merged findings, most severe first</caption>
      <thead>
        <tr>
          <th scope="col">Priority</th>
          <th scope="col">Ref</th>
          <th scope="col">Category</th>
          <th scope="col">Location</th>
          <th scope="col">Finding</th>
          <th scope="col">Recommendation</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="finding in findings" :key="finding.findingRef">
          <td>
            <v-chip :color="PRIORITY_COLORS[finding.priority]" size="small">
              {{ finding.priority }}
            </v-chip>
          </td>
          <td>{{ finding.findingRef }}</td>
          <td>{{ finding.category }}</td>
          <td>{{ locationLabel(finding) }}</td>
          <td>{{ finding.finding }}</td>
          <td>{{ finding.recommendation }}</td>
        </tr>
      </tbody>
    </table>

    <h3 id="full-report-heading">Reviewer Output</h3>
    <MarkdownView
      v-if="fullReport !== null"
      aria-labelledby="full-report-heading"
      :markdown="fullReport"
    />
    <p v-else>The full report is not available yet.</p>
  </section>
</template>

<style scoped>
.review-report {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.severity-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.severity-summary li {
  align-items: center;
  display: flex;
}

.findings-table {
  border-collapse: collapse;
  margin-block: 0.5rem 1rem;
  width: 100%;
}

.findings-table th,
.findings-table td {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 0.5rem 0.75rem;
  text-align: left;
  vertical-align: top;
}

.sr-only {
  border: 0;
  clip: rect(0, 0, 0, 0);
  height: 1px;
  margin: -1px;
  overflow: hidden;
  padding: 0;
  position: absolute;
  width: 1px;
}
</style>
