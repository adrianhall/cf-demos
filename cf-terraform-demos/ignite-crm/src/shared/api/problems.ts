/**
 * @file RFC 9457 problem-details wire shape returned by every failing API call. The Application
 *   Worker emits these through the toolkit's error handler; the SPA validates them before deciding
 *   how to present a failure. Extension members are flattened to the top level, as RFC 9457 §3.2
 *   specifies.
 */

import * as v from 'valibot';
import { SERVICE_ERROR_CODES } from '../common/errors.ts';

/**
 * Media type of a problem-details body.
 */
export const PROBLEM_JSON = 'application/problem+json';

/**
 * Schema for a problem-details body. Unknown members are permitted (`looseObject`) because RFC 9457
 * allows producers to add extensions a consumer must ignore.
 */
export const ProblemSchema = v.looseObject({
  /**
   * Problem type URI; `about:blank` when the status says everything.
   */
  type: v.string(),
  /**
   * HTTP status code.
   */
  status: v.pipe(v.number(), v.integer(), v.minValue(400), v.maxValue(599)),
  /**
   * Short, status-level summary.
   */
  title: v.string(),
  /**
   * Safe explanation specific to this occurrence.
   */
  detail: v.optional(v.string()),
  /**
   * URI reference identifying this occurrence.
   */
  instance: v.optional(v.string()),
  /**
   * Stable service error code, when the failure originated in the Data Worker.
   */
  code: v.optional(v.picklist(SERVICE_ERROR_CODES)),
  /**
   * Request identifier for support and log correlation.
   */
  requestId: v.optional(v.string()),
  /**
   * Whether the client may retry the same request.
   */
  retryable: v.optional(v.boolean()),
  /**
   * Per-field validation messages.
   */
  fields: v.optional(v.record(v.string(), v.string()))
});

/**
 * A problem-details body.
 */
export type Problem = v.InferOutput<typeof ProblemSchema>;
