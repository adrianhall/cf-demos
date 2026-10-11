/**
 * @file Input validation for Data Worker use cases. The Application Worker validates at the edge
 *   too, but the Data Worker cannot assume its only caller is well-behaved: a future MCP transport
 *   will call the same contract. Validating here means every transport enforces identical rules.
 */

import * as v from 'valibot';
import { serviceError } from '../../../shared/common/errors.ts';
import { IdSchema } from '../../../shared/common/ids.ts';
import type { ActorContext } from '../../../shared/data-service/contract.ts';
import { IdempotencyKeySchema } from '../../../shared/validation/fields.ts';
import { issueFields } from '../../../shared/validation/issues.ts';

/**
 * Validate a value or throw a `VALIDATION_FAILED` service error with per-field messages.
 *
 * @param schema The schema.
 * @param value Untrusted input.
 * @param requestId Request identifier for the error.
 * @returns The parsed output.
 * @throws {Error} A `VALIDATION_FAILED` service error naming each invalid field.
 */
export function validate<TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
  requestId: string
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, value);
  if (result.success) {
    return result.output;
  }
  throw serviceError('VALIDATION_FAILED', 'The request contains invalid fields.', {
    requestId,
    fields: issueFields(result.issues)
  });
}

/**
 * Validate an entity identifier argument.
 *
 * @param id Untrusted identifier.
 * @param requestId Request identifier for the error.
 * @returns The identifier.
 * @throws {Error} A `VALIDATION_FAILED` service error when it is not a lowercase UUID.
 */
export function validateId(id: unknown, requestId: string): string {
  return validate(IdSchema, id, requestId);
}

/**
 * Validate an idempotency key argument.
 *
 * @param key Untrusted key.
 * @param requestId Request identifier for the error.
 * @returns The key.
 * @throws {Error} A `VALIDATION_FAILED` service error when it is malformed.
 */
export function validateIdempotencyKey(key: unknown, requestId: string): string {
  return validate(IdempotencyKeySchema, key, requestId);
}

/**
 * Schema for the actor context crossing the RPC boundary.
 */
const ActorContextSchema = v.strictObject({
  email: v.pipe(v.string(), v.minLength(3), v.maxLength(254)),
  userId: IdSchema,
  requestId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  channel: v.literal('api')
});

/**
 * Validate the actor context.
 *
 * @param actor Untrusted actor context.
 * @returns The actor.
 * @throws {Error} A `VALIDATION_FAILED` service error when it is malformed.
 */
export function validateActor(actor: unknown): ActorContext {
  const requestId =
    typeof actor === 'object'
    && actor !== null
    && typeof (actor as { requestId?: unknown }).requestId === 'string'
      ? (actor as { requestId: string }).requestId
      : 'unknown';
  return validate(ActorContextSchema, actor, requestId);
}
