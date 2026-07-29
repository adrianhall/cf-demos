/**
 * Determines a suitable error message for a thrown error
 * @param error the error thrown
 * @param defaultMsg the default message
 * @returns a string version of the error
 */
export function getErrorMessage(error: unknown, defaultMsg: string): string {
  return error instanceof Error ? error.message : defaultMsg;
}

/**
 * Parses JSON text, treating an empty string as an empty object instead of
 * letting `JSON.parse` throw on it. A browser XHR's `responseText` is empty
 * for some failure responses that still need to reach normal error handling.
 * @param text the raw response text, which may be empty
 * @returns the parsed value
 * @throws SyntaxError when text is non-empty and not valid JSON
 */
export function parseJsonOrEmpty<T>(text: string): T {
  return JSON.parse(text || "{}") as T;
}

/**
 * Invokes an upload progress handler only when the browser reports a
 * measurable byte count, guarding against progress events where the total
 * size is unknown (`lengthComputable` is `false`).
 * @param onProgress callback invoked with a rounded percentage complete
 * @param event the browser XHR upload progress event
 */
export function wrapOnProgress(
  onProgress: (progress: number) => void,
  event: ProgressEvent,
): void {
  if (event.lengthComputable) {
    onProgress(Math.round((event.loaded / event.total) * 100));
  }
}
