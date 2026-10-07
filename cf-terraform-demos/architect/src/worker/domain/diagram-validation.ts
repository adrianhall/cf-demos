import { badRequest, notFound, unprocessableContent } from '@adrianhall/cloudflare-toolkit/errors';
import type { CreateDiagramInput, UpdateDiagramInput } from './diagram.ts';

/**
 * @file Diagram metadata validation. Pure, so the HTTP API and the later MCP tool layer reject the
 *   same values for the same reasons rather than each enforcing its own idea of a valid title.
 */

/**
 * Longest accepted title, matching the editor's own `maxLength` on the field.
 *
 * Bounded so one diagram cannot be used to store bulk text in a shared table, and so a dashboard
 * card can render any title without the layout depending on a user's restraint.
 */
const MAX_TITLE_LENGTH = 255;

/**
 * Longest accepted description.
 */
const MAX_DESCRIPTION_LENGTH = 2_000;

/**
 * Shape every diagram id must match: a UUID as produced by `crypto.randomUUID()` in the adapter.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Validates a title, shared by create and update.
 *
 * @param value Candidate title from an untrusted body.
 * @returns The trimmed title.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the value is not a string, or
 *   is empty or whitespace-only after trimming, or exceeds {@link MAX_TITLE_LENGTH}.
 */
function validateTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw unprocessableContent({ detail: 'title must be a string.' });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) {
    throw unprocessableContent({
      detail: `title must be between 1 and ${MAX_TITLE_LENGTH} characters.`
    });
  }
  return trimmed;
}

/**
 * Validates a description, shared by create and update.
 *
 * `null` is accepted and means "clear it". An omitted property is a different thing entirely and is
 * never routed here — the callers below distinguish the two with `Reflect.has`, so a client can
 * clear a description without also being able to clear it by accident through an absent field.
 *
 * @param value Candidate description from an untrusted body.
 * @returns The trimmed description, or `null` to clear it.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the value is neither `null` nor
 *   a string, or exceeds {@link MAX_DESCRIPTION_LENGTH}.
 */
function validateDescription(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw unprocessableContent({ detail: 'description must be a string or null.' });
  }

  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw unprocessableContent({
      detail: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`
    });
  }
  return trimmed;
}

/**
 * Validates a diagram id taken from a request path.
 *
 * A malformed id is reported as `404`, not `400`, and that is deliberate: this API's contract is
 * that a caller can never distinguish "no such diagram", "that diagram belongs to someone else" and
 * "that is not even an id". Answering `400` for the third case would turn the id format into an
 * oracle a caller could use to tell a real id apart from a guessed one.
 *
 * @param id Candidate id from the request path.
 * @returns The validated id.
 * @throws {ProblemDetailsError} `notFound()` (404) when the id is not a UUID.
 */
export function validateDiagramId(id: string): string {
  if (!UUID_PATTERN.test(id)) {
    throw notFound({ detail: 'Diagram not found.' });
  }
  return id;
}

/**
 * Validates a create-diagram request body.
 *
 * Every field is optional: creating a diagram with no body at all produces a blank canvas with the
 * default title, which is exactly what the blank-canvas card does.
 *
 * @param value Parsed JSON body.
 * @returns Validated create input, carrying only the fields the caller actually supplied.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not a plain object, and
 *   `unprocessableContent()` (422) when a supplied field fails its own rule.
 */
export function validateCreateDiagramInput(value: unknown): CreateDiagramInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest({ detail: 'The request body must be an object.' });
  }

  const input: CreateDiagramInput = {};

  const title = Reflect.get(value, 'title');
  if (title !== undefined) {
    input.title = validateTitle(title);
  }

  const description = Reflect.get(value, 'description');
  if (description !== undefined) {
    input.description = validateDescription(description);
  }

  const blueprintId = Reflect.get(value, 'blueprintId');
  if (blueprintId !== undefined) {
    if (typeof blueprintId !== 'string' || blueprintId.trim().length === 0) {
      throw unprocessableContent({ detail: 'blueprintId must be a non-empty string.' });
    }
    input.blueprintId = blueprintId;
  }

  return input;
}

/**
 * Validates a metadata-update request body.
 *
 * A body carrying neither field is refused rather than treated as a no-op write. A request that
 * changes nothing still bumps `updatedAt`, which reorders the dashboard, so it is a mistake worth
 * reporting rather than absorbing.
 *
 * @param value Parsed JSON body.
 * @returns Validated update input, carrying only the fields the caller supplied.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not a plain object, and
 *   `unprocessableContent()` (422) when a supplied field fails its rule or when the body carries
 *   neither `title` nor `description`.
 */
export function validateUpdateDiagramInput(value: unknown): UpdateDiagramInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest({ detail: 'The request body must be an object.' });
  }

  const input: UpdateDiagramInput = {};
  let sawField = false;

  const title = Reflect.get(value, 'title');
  if (title !== undefined) {
    input.title = validateTitle(title);
    sawField = true;
  }

  // `Reflect.has`, not a `!== undefined` check: `{ description: null }` means "clear it" and must
  // be honoured, which an undefined test would silently discard.
  if (Reflect.has(value, 'description')) {
    input.description = validateDescription(Reflect.get(value, 'description'));
    sawField = true;
  }

  if (!sawField) {
    throw unprocessableContent({
      detail: 'The request body must include title and/or description.'
    });
  }

  return input;
}
