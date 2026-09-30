import { badRequest, notFound, unprocessableContent } from '@adrianhall/cloudflare-toolkit/errors';
import type { CreateChannelInput, PostMessageInput } from './channel';

/**
 * Longest accepted channel name. Short on purpose: the name is also the Durable Object's name and
 * the sidebar label, so it must stay readable in both roles.
 */
const MAX_CHANNEL_NAME_LENGTH = 32;

/**
 * Longest accepted message body. Bounded so one message cannot be used to store bulk data in a
 * room's SQLite storage, and so replaying a full history frame stays a small, predictable payload.
 */
const MAX_MESSAGE_LENGTH = 2_000;

/**
 * Shape every channel name must match: a lowercase letter followed by lowercase letters, digits, or
 * hyphens.
 *
 * The character set is restricted for a security reason rather than an aesthetic one. A channel
 * name is used verbatim as a Durable Object name and interpolated into a URL path, so allowing
 * arbitrary text would invite path-traversal-shaped names (`../other`) and pairs of names that
 * differ only by invisible or case-folded characters — two channels that look identical in the
 * sidebar but address two different rooms.
 */
export const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

/**
 * Channel names that would collide with this Worker's own routing if they were ever placed in a URL
 * path. Reserved rather than escaped, so a confusing name never exists in the first place.
 */
const RESERVED_CHANNEL_NAMES = new Set(['api', 'channels', 'me', 'socket']);

/**
 * Any Unicode control character (category `Cc`).
 *
 * Message bodies are rendered as text by the UI, so control characters cannot execute anything —
 * but they can corrupt a log line, hide content from a reader, or make two visually identical
 * messages differ. Rejecting them keeps the stored history exactly what it appears to be.
 */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

/**
 * Ensure a parsed JSON value is a plain object suitable for a request payload.
 *
 * Arrays and `null` are rejected explicitly: both are `typeof "object"` in JavaScript, so a naive
 * check would let `[]` or `null` reach property access and produce a confusing `422` instead of a
 * clear `400` about the body's shape.
 *
 * @param value Parsed JSON value.
 * @returns The same value narrowed to an object with string keys.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is not a plain JSON object.
 */
function validateObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest({ detail: 'The request body must be an object.' });
  }
  return value as Record<string, unknown>;
}

/**
 * Normalize and validate a channel name.
 *
 * Normalization happens before validation, so ` General ` and `general` are the same channel rather
 * than two. That matters more here than in a typical form field: the normalized value is the
 * Durable Object's name, so two spellings that normalized differently would silently create two
 * separate conversations that look like one in the directory.
 *
 * @param value Candidate channel name from a request body or URL path.
 * @returns The trimmed, lowercased name.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the value is not a string, is
 *   empty, exceeds {@link MAX_CHANNEL_NAME_LENGTH}, does not match {@link CHANNEL_NAME_PATTERN}, or
 *   is one of the reserved names.
 */
export function validateChannelName(value: unknown): string {
  if (typeof value !== 'string') {
    throw unprocessableContent({ detail: 'name must be a string.' });
  }

  const name = value.trim().toLowerCase();
  if (
    name.length === 0
    || name.length > MAX_CHANNEL_NAME_LENGTH
    || !CHANNEL_NAME_PATTERN.test(name)
    || RESERVED_CHANNEL_NAMES.has(name)
  ) {
    throw unprocessableContent({
      detail:
        `name must start with a lowercase letter, contain only lowercase letters, digits, and `
        + `hyphens, and be at most ${MAX_CHANNEL_NAME_LENGTH} characters.`
    });
  }
  return name;
}

/**
 * Validate a channel name taken from a URL path.
 *
 * A malformed name raises `notFound()` rather than a validation error on purpose. From a caller's
 * point of view `/api/channels/NOT valid` and `/api/channels/never-created` are the same situation
 * — no such channel — and answering them identically keeps the path from behaving as a probe for
 * which names are syntactically routable.
 *
 * @param value Candidate channel name from the URL path.
 * @returns The normalized name.
 * @throws {ProblemDetailsError} `notFound()` (404) when the name is not a valid channel name.
 */
export function validateChannelPathName(value: string): string {
  try {
    return validateChannelName(value);
  } catch {
    throw notFound({ detail: 'Channel not found.' });
  }
}

/**
 * Validate a create-channel request payload.
 *
 * Unknown properties are rejected rather than ignored, so a client that tries to set `createdBy`
 * finds out immediately instead of silently having it overwritten by the server. That specific
 * mistake is worth a loud failure: it means the client believed it could choose an author.
 *
 * @param value Parsed JSON body from the request.
 * @returns Validated creation input with a normalized name.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object;
 *   `unprocessableContent()` (422) when a property other than `name` is present, or when `name` is
 *   missing or invalid.
 */
export function validateCreateChannelInput(value: unknown): CreateChannelInput {
  const body = validateObject(value);
  const unexpected = Object.keys(body).filter((key) => key !== 'name');
  if (unexpected.length > 0) {
    throw unprocessableContent({
      detail: `Only name may be supplied; received ${unexpected.join(', ')}.`
    });
  }
  return { name: validateChannelName(body.name) };
}

/**
 * Validate one decoded WebSocket frame sent by a participant.
 *
 * This runs on the room's side of the connection rather than in an HTTP route, which is exactly why
 * it lives in the domain layer: a message arriving over a socket must be held to the identical
 * rules an HTTP transport would apply. The frame carries only `body` — notably not an author —
 * because the author is pinned to the connection and a client is never permitted to assert one.
 *
 * @param value Parsed JSON value decoded from the frame.
 * @returns Validated message input with a trimmed body.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the frame is not a JSON object;
 *   `unprocessableContent()` (422) when a property other than `body` is present (including an
 *   attempt to supply `author`), or when `body` is missing, not a string, empty after trimming,
 *   longer than {@link MAX_MESSAGE_LENGTH}, or contains control characters.
 */
export function validatePostMessageInput(value: unknown): PostMessageInput {
  const frame = validateObject(value);
  const unexpected = Object.keys(frame).filter((key) => key !== 'body');
  if (unexpected.length > 0) {
    throw unprocessableContent({
      detail: `Only body may be supplied; received ${unexpected.join(', ')}.`
    });
  }

  if (typeof frame.body !== 'string') {
    throw unprocessableContent({ detail: 'body must be a string.' });
  }

  const body = frame.body.trim();
  if (body.length === 0 || body.length > MAX_MESSAGE_LENGTH) {
    throw unprocessableContent({
      detail: `body must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`
    });
  }
  if (CONTROL_CHARACTER_PATTERN.test(body)) {
    throw unprocessableContent({ detail: 'body must not contain control characters.' });
  }
  return { body };
}
