/**
 * @file Assertion helper for the toolkit's RFC 9457 errors. `ProblemDetailsError` carries its
 *   status inside a `problemDetails` payload (the document the error handler serializes) rather
 *   than as a top-level `status` property. Tests assert on the status because the difference
 *   between a `400` and a `502` is part of each module's contract, so this helper gives them one
 *   correct way to read it.
 */

/**
 * Matcher object asserting that a rejected promise carries a given problem-details status.
 *
 * Use with `rejects.toMatchObject(...)`:
 *
 * ```ts
 * await expect(client.run(request)).rejects.toMatchObject(problemWithStatus(502));
 * ```
 *
 * @param status Expected HTTP status.
 * @returns A partial shape matching a `ProblemDetailsError` with that status.
 */
export function problemWithStatus(status: number): { problemDetails: { status: number } } {
  return { problemDetails: { status } };
}

/**
 * Captures the error a synchronous call throws.
 *
 * `expect(fn).toThrow(problemWithStatus(400))` does not work: `toThrow` compares against a message,
 * a class, or a regular expression, and silently treats a plain object as a message match.
 * Capturing the thrown value and using `toMatchObject` is the combination that actually asserts on
 * the status.
 *
 * @param call The call expected to throw.
 * @returns The thrown value, or `undefined` when the call returned normally — which fails the
 *   following `toMatchObject` rather than passing silently.
 */
export function thrownBy(call: () => unknown): unknown {
  try {
    call();
    return undefined;
  } catch (cause: unknown) {
    return cause;
  }
}
