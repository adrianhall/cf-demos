/**
 * Safe conversion of Data Worker failures into transport-neutral agent errors.
 */
import type { ServiceErrorValue } from '../../shared/common/errors.ts';

/**
 * A bounded error suitable for an LLM or protocol client.
 */
export interface AgentToolError {
  /**
   * Stable category.
   */
  readonly code: string;
  /**
   * Safe user-facing detail.
   */
  readonly message: string;
  /**
   * Whether retrying may succeed.
   */
  readonly retryable: boolean;
  /**
   * Request correlation identifier.
   */
  readonly requestId: string;
}

/**
 * Map a service failure without enumerating hidden records or echoing stored content.
 *
 * @param error Service-shaped failure.
 * @returns A safe tool error.
 */
export function presentToolError(error: ServiceErrorValue): AgentToolError {
  const message =
    error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND'
      ? 'The requested record is not available.'
      : error.code === 'CONFLICT'
        ? 'The record changed while this request was running.'
        : error.message;
  return { code: error.code, message, retryable: error.retryable, requestId: error.requestId };
}
