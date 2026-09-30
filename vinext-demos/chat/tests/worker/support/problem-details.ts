/**
 * @file Assertion helpers for the toolkit's RFC 9457 errors. `ProblemDetailsError` carries its
 *   status inside a `problemDetails` payload (the document the error handler serializes) rather
 *   than as a top-level `status` property. Tests assert on the status because the difference
 *   between `400`, `404`, `409`, and `422` is part of each module's contract, so these helpers give
 *   them one correct way to read it.
 */

/**
 * Read the HTTP status a synchronously thrown problem-details error carries.
 *
 * Returns the status rather than asserting on it, so a test reads as
 * `expect(statusOf(...)).toBe(422)` — which reports the _actual_ status on failure instead of
 * merely "did not match", making a wrong-status regression obvious at a glance.
 *
 * @param call Function expected to throw a problem-details error.
 * @returns The status from the thrown error, or `undefined` when nothing was thrown or the thrown
 *   value was not a problem-details error.
 */
export function statusOf(call: () => unknown): number | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    return (error as { problemDetails?: { status?: number } }).problemDetails?.status;
  }
}

/**
 * Matcher object asserting that a rejected promise carries a given problem-details status.
 *
 * Use with `rejects.toMatchObject(...)`, which is the asynchronous counterpart to {@link statusOf}:
 *
 * ```ts
 * await expect(service.removeChannel('nope')).rejects.toMatchObject(problemWithStatus(404));
 * ```
 *
 * @param status Expected HTTP status.
 * @returns A partial shape matching a `ProblemDetailsError` with that status.
 */
export function problemWithStatus(status: number): { problemDetails: { status: number } } {
  return { problemDetails: { status } };
}
