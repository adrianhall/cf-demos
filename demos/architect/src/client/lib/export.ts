/**
 * Diagram export filename generation and browser download helpers.
 *
 * Ported directly from CF-Architect's `src/lib/export.ts` (docs/09-ARCHITECT.md Phase 5) — pure,
 * framework-agnostic logic with no changes needed for this host app. Used by
 * `../components/editor/toolbar/ExportButton.tsx` for the PNG/SVG/project-scaffold exports.
 */

/** File formats {@link generateExportFilename} can produce a name for. */
export type ExportFormat = "png" | "svg" | "zip";

/**
 * Builds an export filename from the diagram title and current timestamp.
 *
 * Format: `<sanitized-title>_<YYYY-MM-DD>_<HHmm>.<format>`. Non-alphanumeric characters (other
 * than spaces) are stripped, spaces become underscores, and a blank/all-punctuation title falls
 * back to `diagram` so the result is never an unusable filename.
 *
 * @param title Raw diagram title (sanitized before use).
 * @param format File extension to append (`"png"`, `"svg"`, or `"zip"`).
 * @param now Optional date override, for deterministic tests.
 */
export function generateExportFilename(
  title: string,
  format: ExportFormat,
  now: Date = new Date(),
): string {
  const sanitized = title
    .replace(/[^a-zA-Z0-9 ]/g, "_")
    .replace(/ /g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const name = sanitized || "diagram";

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");

  return `${name}_${yyyy}-${mm}-${dd}_${hh}${min}.${format}`;
}

/**
 * Triggers a browser file download from a data URL or object URL.
 *
 * Creates a temporary, invisible `<a download>` element, clicks it, and removes it — the
 * standard client-side pattern for saving generated (rather than server-hosted) content, since
 * there is no URL a real navigation could target.
 */
export function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}
