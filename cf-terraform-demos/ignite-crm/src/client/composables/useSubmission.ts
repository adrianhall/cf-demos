/**
 * @file Form submission state shared by every create/edit dialog: in-flight flag, server field and
 *   form errors, version-conflict detection, and the idempotency key for the current intent.
 *   **Idempotency key policy.** A key may only be reused for an _identical_ retry. The composable
 *   therefore keeps the key only when the previous attempt failed in a way that leaves its outcome
 *   unknown (a network failure or a 503 — the server may have committed and the response been
 *   lost). Any other outcome — success, validation failure, denial, or conflict — means the next
 *   submission is a new request, so it gets a new key; reusing the old one with a corrected draft
 *   would be refused as `IDEMPOTENCY_KEY_REUSED`. **Drafts are never discarded here.** The
 *   composable holds no form data; forms own their drafts and keep them across failures, including
 *   a `409` conflict, so the user can reload the latest version and reapply their edits.
 */

import { ref, type Ref, shallowRef } from 'vue';
import { ApiError, newIdempotencyKey } from '../services/api-client.ts';

/**
 * Messages a caller can customise.
 */
export interface SubmissionMessages {
  /**
   * Shown when the server refuses the action for this role.
   */
  readonly forbidden: string;
  /**
   * Shown when the record changed since it was loaded.
   */
  readonly conflict?: string;
}

/**
 * What {@link useSubmission} returns.
 */
export interface UseSubmission {
  /**
   * Whether a submission is in flight.
   */
  readonly submitting: Ref<boolean>;
  /**
   * Server field messages from the last attempt.
   */
  readonly fieldErrors: Ref<Record<string, string>>;
  /**
   * Form-level message from the last attempt.
   */
  readonly formError: Ref<string | null>;
  /**
   * Whether the last attempt failed because the record changed underneath the user.
   */
  readonly conflict: Ref<boolean>;
  /**
   * Whether the last attempt was refused as a state conflict (`CONFLICT`), e.g. the deal was
   * already converted: retrying would not help, but reloading shows why.
   */
  readonly alreadyApplied: Ref<boolean>;
  /**
   * Clear errors and start a new intent (call when opening a dialog).
   */
  reset(): void;
  /**
   * Submit.
   *
   * @param action Performs the request with the intent's idempotency key.
   * @returns The result, or `undefined` when the attempt failed (errors are then set).
   */
  run<T>(action: (idempotencyKey: string) => Promise<T>): Promise<T | undefined>;
}

/**
 * Manage one form's submissions.
 *
 * @param messages Role-denial and conflict messages.
 * @returns The submission state and runner.
 */
export function useSubmission(messages: SubmissionMessages): UseSubmission {
  const submitting = ref(false);
  const fieldErrors = shallowRef<Record<string, string>>({});
  const formError = ref<string | null>(null);
  const conflict = ref(false);
  const alreadyApplied = ref(false);
  let key = newIdempotencyKey();

  /**
   * Clear errors and rotate the key.
   */
  function reset(): void {
    fieldErrors.value = {};
    formError.value = null;
    conflict.value = false;
    alreadyApplied.value = false;
    key = newIdempotencyKey();
  }

  /**
   * Submit with the current key, then decide whether the next attempt may reuse it.
   *
   * @param action The request.
   * @returns The result, or `undefined` on failure.
   */
  async function run<T>(action: (idempotencyKey: string) => Promise<T>): Promise<T | undefined> {
    submitting.value = true;
    fieldErrors.value = {};
    formError.value = null;
    conflict.value = false;
    alreadyApplied.value = false;
    try {
      const result = await action(key);
      key = newIdempotencyKey();
      return result;
    } catch (caught) {
      const error =
        caught instanceof ApiError ? caught : new ApiError('server', 'Something went wrong.', 0);
      const outcomeUnknown = error.kind === 'network' || error.kind === 'unavailable';
      if (!outcomeUnknown) {
        key = newIdempotencyKey();
      }
      fieldErrors.value = { ...error.fields };
      conflict.value = error.kind === 'conflict' && error.problem?.code === 'VERSION_MISMATCH';
      alreadyApplied.value = error.kind === 'conflict' && error.problem?.code === 'CONFLICT';
      formError.value =
        error.kind === 'forbidden'
          ? messages.forbidden
          : conflict.value
            ? (messages.conflict
              ?? 'Someone else changed this record. Your changes are kept below; reload the latest version, then save again.')
            : error.message;
      return undefined;
    } finally {
      submitting.value = false;
    }
  }

  return { submitting, fieldErrors, formError, conflict, alreadyApplied, reset, run };
}
