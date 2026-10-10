/**
 * File extensions this demo treats as "UI-relevant" (docs/07-PR-REVIEW-AGENT.md, "Reviewer
 * Personas And Structured Findings"'s table, `accessibility`'s "Skipped when" column). Matched
 * case-insensitively against a changed file's own extension.
 */
const UI_RELEVANT_EXTENSIONS = new Set([
  ".vue",
  ".tsx",
  ".jsx",
  ".html",
  ".astro",
  ".css",
  ".scss",
]);

/**
 * Whether at least one changed file has a UI-relevant extension -- the sole condition
 * `ReviewPipelineWorkflow` uses to decide whether the accessibility reviewer runs at all
 * (docs/07-PR-REVIEW-AGENT.md, "Behavior": "The Accessibility pass is skipped (not run, not
 * billed) when no changed file has a UI-relevant extension"). Factored out into its own pure,
 * unit-testable function per Implementation Plan Phase 4, item 19's own encouragement, since a
 * Workflow step's control flow itself cannot be driven from a plain Vitest unit test.
 *
 * @param changedFiles The diff's changed-file list (`GitProviderClient.fetchDiff()`'s own
 * result) -- evaluated once, from the whole list, never per individual reviewer pass.
 * @returns `true` if at least one path's extension is UI-relevant.
 */
export function hasUiRelevantChangedFile(
  changedFiles: readonly string[],
): boolean {
  return changedFiles.some((path) => {
    const dotIndex = path.lastIndexOf(".");
    if (dotIndex === -1) {
      return false;
    }
    return UI_RELEVANT_EXTENSIONS.has(path.slice(dotIndex).toLowerCase());
  });
}
