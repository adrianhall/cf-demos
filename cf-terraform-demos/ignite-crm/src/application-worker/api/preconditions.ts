/**
 * @file Request preconditions shared by every `/api/v1` route module: the mandatory
 *   `Idempotency-Key` on mutations, the mandatory `If-Match` version on updates, and the `:id` path
 *   parameter. One module, so every route answers a missing or malformed header identically (`428`
 *   when absent, `422` when malformed) and no route module imports another's helpers.
 */

import * as v from 'valibot';
import { preconditionRequired } from '@adrianhall/cloudflare-toolkit/errors';
import { IdSchema } from '../../shared/common/ids.ts';
import type { MutationMeta } from '../../shared/data-service/contract.ts';
import { IdempotencyKeySchema } from '../../shared/validation/fields.ts';
import type { ApiContext } from './context.ts';
import { parseRequest } from './problems.ts';

/**
 * Schema for an `If-Match` header carrying a weak or strong numeric version ETag.
 */
const IfMatchSchema = v.pipe(
  v.string(),
  v.regex(/^(?:W\/)?"\d{1,9}"$/u, 'If-Match must be a version ETag such as "3".'),
  v.transform((value) => Number(value.replace(/^W\//u, '').replaceAll('"', ''))),
  v.minValue(1)
);

/**
 * Read the mandatory `Idempotency-Key` header.
 *
 * @param context Request context.
 * @returns Mutation metadata.
 * @throws {ProblemDetailsError} `428` when absent, `422` when malformed.
 */
export function mutationMeta(context: ApiContext): MutationMeta {
  const header = context.req.header('Idempotency-Key');
  if (header === undefined) {
    throw preconditionRequired({
      detail: 'Mutations require an Idempotency-Key header.',
      extensions: { requestId: context.get('requestId') }
    });
  }
  return {
    idempotencyKey: parseRequest(
      IdempotencyKeySchema,
      header,
      context.get('requestId'),
      'header',
      'Idempotency-Key'
    )
  };
}

/**
 * Read the mandatory `If-Match` header.
 *
 * @param context Request context.
 * @returns The expected version.
 * @throws {ProblemDetailsError} `428` when absent, `422` when malformed.
 */
export function expectedVersion(context: ApiContext): number {
  const header = context.req.header('If-Match');
  if (header === undefined) {
    throw preconditionRequired({
      detail: 'Updates require an If-Match header with the version you last read.',
      extensions: { requestId: context.get('requestId') }
    });
  }
  return parseRequest(IfMatchSchema, header, context.get('requestId'), 'header', 'If-Match');
}

/**
 * Parse an `:id` path parameter.
 *
 * @param context Request context.
 * @returns The identifier.
 * @throws {ProblemDetailsError} `422` when it is not a lowercase UUID.
 */
export function pathId(context: ApiContext): string {
  return parseRequest(IdSchema, context.req.param('id'), context.get('requestId'), 'path');
}
