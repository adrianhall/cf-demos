/**
 * @file The logging surface the application and infrastructure tiers need in order to record _why_
 *   something failed. It lives in `ports/` rather than beside either consumer because both tiers
 *   use it and neither should import the other: the application tier depending on an infrastructure
 *   module would invert the dependency direction the architecture test enforces. It is declared
 *   structurally rather than importing the toolkit's `Logger`, so these tiers depend on a shape
 *   rather than a logging implementation, and a test can pass a plain recorder.
 */

/**
 * Records diagnostic events.
 *
 * Deliberately narrow: only the two levels that describe something going wrong. A tier that wanted
 * to log an ordinary success is describing request flow, which belongs in the route where the
 * request context lives.
 */
export interface DiagnosticLogger {
  /**
   * Records a non-fatal problem.
   *
   * @param message Event name, in `snake_case` so log searches are predictable.
   * @param context Structured fields. Must never carry prompt text, generated media, or the
   *   verified email — the email belongs in AI Gateway metadata only.
   * @returns Nothing.
   */
  warn: (message: string, context?: Record<string, unknown>) => void;
  /**
   * Records a failure.
   *
   * @param message Event name, in `snake_case`.
   * @param context Structured fields, under the same restrictions as {@link DiagnosticLogger.warn}.
   * @returns Nothing.
   */
  error: (message: string, context?: Record<string, unknown>) => void;
}
