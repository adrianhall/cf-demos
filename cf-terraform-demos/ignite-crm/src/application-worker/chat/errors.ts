/**
 * Safe messages for terminal chat stream failures.
 */

/**
 * User-facing billing failure text shared by server stream encoding and client presentation.
 */
export const CHAT_BILLING_FAILURE =
  'The assistant is unavailable because Workers AI billing needs attention. CRM data and actions are unaffected.';

/**
 * User-facing temporary-limit text.
 */
export const CHAT_LIMIT_FAILURE =
  'The assistant has reached its temporary usage limit. Try again shortly.';

/**
 * Return a safe message for a provider failure without exposing provider response details.
 *
 * @param error Provider or transport error.
 * @returns A bounded message suitable for the chat stream.
 */
export function chatStreamErrorMessage(error: unknown): string {
  if (hasStatus(error, 402)) {
    return CHAT_BILLING_FAILURE;
  }
  if (hasStatus(error, 429)) {
    return CHAT_LIMIT_FAILURE;
  }
  return 'The assistant could not complete this request.';
}

/**
 * Match a status on common provider error shapes, including nested causes.
 *
 * @param error Unknown error value.
 * @param status HTTP status.
 * @returns Whether the status was found.
 */
function hasStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const value = error as { status?: unknown; statusCode?: unknown; cause?: unknown };
  return value.status === status || value.statusCode === status || hasStatus(value.cause, status);
}
