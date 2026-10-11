/**
 * @file Map Data Worker service errors and API validation failures onto RFC 9457 problems.
 */

import * as v from 'valibot';
import type { ProblemDetailsInput } from '@adrianhall/cloudflare-toolkit/problem-details';
import { problemDetails } from '@adrianhall/cloudflare-toolkit/problem-details';
import { isServiceError, type ServiceErrorCode } from '../../shared/common/errors.ts';
import { issueFields } from '../../shared/validation/issues.ts';

/**
 * HTTP status for each service error code.
 */
export const STATUS_FOR_CODE: Readonly<Record<ServiceErrorCode, number>> = {
  VALIDATION_FAILED: 422,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_MISMATCH: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  DEPENDENCY_FAILURE: 503,
  INTERNAL: 500
};

/**
 * Convert a service error into problem details. Used as the error handler's `mapError` hook.
 *
 * Only the service error's safe `message` is exposed. Internal failures get a generic detail.
 *
 * @param error Any error that reached the handler.
 * @returns Problem input, or `undefined` to let the default handling apply.
 */
export function mapServiceError(error: Error): ProblemDetailsInput | undefined {
  if (!isServiceError(error)) {
    return undefined;
  }
  const status = STATUS_FOR_CODE[error.code];
  return {
    status,
    detail: error.code === 'INTERNAL' ? 'An unexpected error occurred.' : error.message,
    extensions: {
      code: error.code,
      requestId: error.requestId,
      retryable: error.retryable,
      ...(error.fields === undefined ? {} : { fields: error.fields })
    }
  };
}

/**
 * Parse untrusted input at the API edge.
 *
 * @param schema The shared request schema.
 * @param value Untrusted input.
 * @param requestId Request identifier for the problem.
 * @param where Which part of the request was invalid (for the message).
 * @param field For a single scalar value such as a header, the name its messages are filed under
 *   (for example `Idempotency-Key`); object inputs name their own fields.
 * @returns The parsed value.
 * @throws {ProblemDetailsError} `422` with per-field messages.
 */
export function parseRequest<TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
  requestId: string,
  where: 'body' | 'query' | 'path' | 'header',
  field?: string
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, value);
  if (result.success) {
    return result.output;
  }
  const fields = issueFields(result.issues);
  throw problemDetails({
    status: 422,
    detail:
      where === 'header'
        ? `The ${field ?? 'request'} header is invalid.`
        : `The request ${where} contains invalid fields.`,
    extensions: {
      code: 'VALIDATION_FAILED',
      requestId,
      retryable: false,
      fields:
        field === undefined
          ? fields
          : { [field]: Object.values(fields)[0] ?? `${field} is invalid.` }
    }
  });
}

/**
 * Check a response DTO against its shared schema before sending it.
 *
 * A mismatch means the Data Worker and API disagree about the wire contract; it is reported as a
 * 500 rather than shipping a body the SPA would reject anyway.
 *
 * @param schema The shared response schema.
 * @param value The DTO.
 * @returns The DTO.
 * @throws {Error} When the DTO does not match.
 */
export function checkResponse<TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    throw new Error(
      `Response failed schema validation: ${JSON.stringify(issueFields(result.issues))}`
    );
  }
  return result.output;
}
