/**
 * @file The browser-side download trigger for the Export control, kept separate from the pure
 * Markdown builder in `./transcript.ts` (see docs/05-AI-CHAT.md, Phase 4, task 21) — this module
 * is a thin DOM side effect with nothing left to unit-test beyond "it invokes the browser
 * download APIs it should".
 */

/**
 * Trigger a browser download of `content` as a file named `filename`, without navigating away
 * from the current page.
 *
 * @param filename Suggested file name, including extension.
 * @param content File contents.
 * @param mimeType MIME type for the generated `Blob`. Defaults to Markdown.
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = "text/markdown",
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}
