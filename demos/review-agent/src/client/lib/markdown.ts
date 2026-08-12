import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * @file Renders a run's full Markdown report (`../../worker/review/report.ts`'s
 * `buildFullReport()`) for `ReviewReport.vue`. No Markdown-rendering dependency existed anywhere
 * in this monorepo yet (`grep -r "marked\|markdown-it\|remark" demos/*\/package.json` found
 * nothing), so this module picks one: `marked` -- a small, dependency-free, actively maintained
 * GFM-table-capable parser, chosen over `markdown-it`/`remark` for having the smallest bundle
 * footprint of the three for this demo's modest needs (no plugin ecosystem, footnotes, or MDX
 * required -- just headings, a paragraph, GFM tables, and passthrough raw HTML for the report's
 * own `<details>`/`<summary>` collapsible sections).
 *
 * `buildFullReport()`'s findings/recommendation text is LLM output derived from a PR/MR's own
 * diff -- content an adversarial PR author could shape to attempt a prompt-injection-flavored
 * XSS (Markdown or raw HTML embedded in a crafted diff comment, echoed back verbatim by a
 * reviewer persona into its `finding`/`recommendation` fields). This module's sanitize step is
 * this demo's actual defense against that, not `marked` itself (which does no sanitization of
 * its own): every rendered document passes through `DOMPurify.sanitize()` before this module
 * ever returns it, so `ReviewReport.vue`'s `v-html` binding only ever receives already-sanitized
 * HTML, per Vue's own template-safety guidance for `v-html`.
 */

// `gfm: true` is required for a fenced ` ``` ` block and, more importantly here, GFM pipe
// tables -- `buildFullReport()`'s severity summary and findings tables are both GFM tables.
marked.setOptions({ gfm: true });

/**
 * Render a Markdown document to sanitized HTML, safe to bind with `v-html`.
 *
 * @param markdown The raw Markdown source (for example a run's `fullReport` field).
 * @returns Sanitized HTML. `<details>`/`<summary>` (the report's own per-reviewer collapsible
 * sections) pass through unchanged -- both are ordinary HTML5 elements already on DOMPurify's
 * default allowlist, confirmed by this module's own colocated test; nothing here needs an
 * explicit `ADD_TAGS` override.
 */
export function renderMarkdown(markdown: string): string {
  const rawHtml = marked.parse(markdown, { async: false });
  return DOMPurify.sanitize(rawHtml);
}
