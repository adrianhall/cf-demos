/**
 * @file Assertion helper for the toolkit's RFC 9457 errors. `ProblemDetailsError` carries its
 *   status inside a `problemDetails` payload (the document the error handler serializes) rather
 *   than as a top-level `status` property. Tests assert on the status because the difference
 *   between `400`, `404`, and `422` is part of each module's contract, so this helper gives them
 *   one correct way to read it.
 */

/**
 * Matcher object asserting that a rejected promise carries a given problem-details status.
 *
 * Use with `rejects.toMatchObject(...)`:
 *
 * ```ts
 * await expect(repository.get(user, id)).rejects.toMatchObject(problemWithStatus(404));
 * ```
 *
 * @param status Expected HTTP status.
 * @returns A partial shape matching a `ProblemDetailsError` with that status.
 */
export function problemWithStatus(status: number): { problemDetails: { status: number } } {
  return { problemDetails: { status } };
}
