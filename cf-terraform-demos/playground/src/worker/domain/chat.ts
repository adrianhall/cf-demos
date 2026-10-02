/**
 * @file Chat request validation. This is the only place a Chat request is checked, so every
 *   transport enforces the same rules: the SSE route calls it, the tests call it directly, and a
 *   future non-streaming route would call the same function rather than re-deriving the limits. It
 *   is a domain module, so it imports no Hono and no bindings — only the shared wire contract and
 *   the reviewed model list. The output is a `ValidatedChatRequest`, a distinct type from the
 *   untrusted `ChatRequest`, so a handler cannot accidentally pass unvalidated input onward: the
 *   type it needs can only be produced by validation.
 */

import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import {
  MAX_MAX_TOKENS,
  MAX_MESSAGE_CHARACTERS,
  MAX_MESSAGES,
  MAX_TEMPERATURE,
  MIN_MAX_TOKENS,
  MIN_TEMPERATURE,
  type ChatMessage,
  type ChatRole
} from '../../shared/chat';
import { findModelForTask, type ModelDescriptor } from './models';

/**
 * The system prompt every Chat run uses.
 *
 * Set here, server-side, and not overridable from the browser. A panel that accepted a caller's
 * system prompt would be a general-purpose prompt proxy wearing a Chat label.
 */
export const CHAT_SYSTEM_PROMPT =
  'You are a concise, helpful assistant in a Cloudflare AI playground. Answer directly and '
  + 'briefly unless asked for detail.';

/**
 * A Chat request that has passed validation.
 *
 * Distinct from `ChatRequest` in `src/shared/chat.ts` on purpose. That is the untrusted shape that
 * arrived in a request body; this is the trusted result, with the model resolved to a reviewed
 * descriptor rather than left as a string. A function taking this type cannot be handed unvalidated
 * input.
 */
export interface ValidatedChatRequest {
  /**
   * Conversation turns, trimmed and known to be within limits.
   */
  messages: ChatMessage[];
  /**
   * The reviewed descriptor the requested model identifier resolved to.
   */
  model: ModelDescriptor;
  /**
   * Opaque run identifier supplied by the browser.
   */
  runId: string;
  /**
   * Sampling temperature, when one was requested and is in range.
   */
  temperature?: number;
  /**
   * Output token budget, when one was requested and is in range.
   */
  maxTokens?: number;
}

/**
 * Roles a caller may supply.
 *
 * `system` is excluded; see {@link CHAT_SYSTEM_PROMPT}.
 */
const ALLOWED_ROLES: readonly string[] = ['user', 'assistant'];

/**
 * Fields a request body must not contain.
 *
 * The actor is always derived from the verified Access identity, so any of these appearing in a
 * body means the caller is attempting to choose who a request is attributed to. The request is
 * rejected rather than having the field stripped: stripping is a silent correction that makes an
 * attack look like success, and leaves nothing for a test to assert on.
 */
const FORBIDDEN_FIELDS: readonly string[] = ['user', 'email', 'actor', 'sub', 'system'];

/**
 * Reads a plain object property without inheriting from the prototype chain.
 *
 * @param source Parsed JSON object.
 * @param key Property to read.
 * @returns The value, or `undefined` when the property is absent.
 */
function property(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Validates one conversation turn.
 *
 * @param value Untrusted array element.
 * @param index Position in the array, used in the error message so a caller can find the bad turn.
 * @returns The trimmed, typed message.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the turn is not an object, carries an
 *   unsupported role, or has empty or over-long content.
 */
function validateMessage(value: unknown, index: number): ChatMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest({ detail: `Message ${index} must be an object.` });
  }

  const source = value as Record<string, unknown>;
  const role = property(source, 'role');
  const content = property(source, 'content');

  if (typeof role !== 'string' || !ALLOWED_ROLES.includes(role)) {
    throw badRequest({
      detail:
        `Message ${index} must have a role of "user" or "assistant". The system prompt is `
        + 'set by the server and cannot be supplied.'
    });
  }

  if (typeof content !== 'string') {
    throw badRequest({ detail: `Message ${index} must have string content.` });
  }

  const trimmed = content.trim();
  if (trimmed === '') {
    throw badRequest({ detail: `Message ${index} cannot be empty.` });
  }

  if ([...trimmed].length > MAX_MESSAGE_CHARACTERS) {
    throw badRequest({
      detail:
        `Message ${index} exceeds the ${MAX_MESSAGE_CHARACTERS.toLocaleString()}-character `
        + 'limit for a single message.'
    });
  }

  return { role: role as ChatRole, content: trimmed };
}

/**
 * Validates an optional numeric option against an inclusive range.
 *
 * @param value Untrusted value, possibly absent.
 * @param name Option name for the error message.
 * @param min Lowest accepted value.
 * @param max Highest accepted value.
 * @returns The number, or `undefined` when the option was absent.
 * @throws {ProblemDetailsError} `badRequest()` (400) when present but not a finite number in range.
 *   `NaN` and `Infinity` are rejected here rather than forwarded: both serialise to `null` in JSON
 *   and would reach the provider as a missing option, making a rejected request look accepted.
 */
function validateRange(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest({ detail: `${name} must be a number.` });
  }

  if (value < min || value > max) {
    throw badRequest({ detail: `${name} must be between ${min} and ${max}.` });
  }

  return value;
}

/**
 * Validates an untrusted Chat request body.
 *
 * @param body Parsed JSON request body, of unknown shape.
 * @returns The validated request with its model resolved to a reviewed descriptor; see
 *   {@link ValidatedChatRequest}.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object; when it
 *   carries an identity or system-prompt field; when `messages` is absent, empty, over-long, or
 *   contains an invalid turn; when the final turn is not from the user; when `runId` is missing or
 *   malformed; when `model` is not a reviewed model registered against the Chat panel; or when
 *   `temperature` or `maxTokens` is out of range.
 */
export function validateChatRequest(body: unknown): ValidatedChatRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest({ detail: 'Request body must be a JSON object.' });
  }

  const source = body as Record<string, unknown>;

  // Checked before anything else, so a spoofing attempt is refused rather than partially processed.
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw badRequest({
        detail:
          `Request body must not contain "${field}". The user is taken from the verified `
          + 'Cloudflare Access identity, and the system prompt is set by the server.'
      });
    }
  }

  const rawMessages = property(source, 'messages');
  if (!Array.isArray(rawMessages)) {
    throw badRequest({ detail: 'Request body must contain a "messages" array.' });
  }

  if (rawMessages.length === 0) {
    throw badRequest({ detail: 'Send at least one message.' });
  }

  if (rawMessages.length > MAX_MESSAGES) {
    throw badRequest({
      detail:
        `Send at most ${MAX_MESSAGES} messages. Chat replays the whole conversation on every `
        + 'turn, so a longer history costs more for every subsequent answer.'
    });
  }

  const messages = rawMessages.map((message, index) => validateMessage(message, index));

  // A conversation ending with an assistant turn has nothing to answer. Catching it here rather
  // than letting the model improvise a continuation keeps the panel's behaviour predictable.
  if (messages.at(-1)?.role !== 'user') {
    throw badRequest({ detail: 'The last message must come from the user.' });
  }

  const runId = property(source, 'runId');
  if (typeof runId !== 'string' || !isPlausibleRunId(runId)) {
    throw badRequest({
      detail:
        'Request body must contain a "runId" of 8 to 64 characters, using letters, digits, '
        + 'hyphens, and underscores only.'
    });
  }

  const modelId = property(source, 'model');
  if (typeof modelId !== 'string') {
    throw badRequest({ detail: 'Request body must contain a "model" identifier.' });
  }

  // Resolved against the Chat panel specifically, not against the whole catalogue. Looking a model
  // up by identifier alone is how a narrow task API becomes a generic `{ model, input }` proxy.
  const model = findModelForTask('chat', modelId);
  if (model === undefined) {
    throw badRequest({
      detail: 'That model is not one of the reviewed models available for Chat.'
    });
  }

  const temperature = validateRange(
    property(source, 'temperature'),
    'temperature',
    MIN_TEMPERATURE,
    MAX_TEMPERATURE
  );
  const maxTokens = validateRange(
    property(source, 'maxTokens'),
    'maxTokens',
    MIN_MAX_TOKENS,
    MAX_MAX_TOKENS
  );

  return {
    messages,
    model,
    runId,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens })
  };
}

/**
 * Reports whether a string is shaped like a run identifier.
 *
 * The run identifier is generated by the browser and ends up in AI Gateway metadata and in a URL
 * path, so its character set is constrained rather than trusted. This checks the shape only: a
 * well-formed identifier for a run that does not exist is a `404`, which is a different answer from
 * a malformed one.
 *
 * @param value Candidate identifier from an untrusted source.
 * @returns `true` when the value is 8 to 64 characters of letters, digits, hyphens, or underscores.
 */
export function isPlausibleRunId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/u.test(value);
}

/**
 * Builds the model input for a validated Chat request.
 *
 * The system prompt is prepended here, so there is exactly one place that decides what the model is
 * told about its role, and `stream` is set by the caller rather than here because the same
 * conversation is sent either way.
 *
 * @param request A validated Chat request.
 * @param stream Whether to ask the model to stream its response.
 * @returns The `messages`-shaped input both reviewed Chat models accept.
 */
export function buildChatInput(
  request: ValidatedChatRequest,
  stream: boolean
): {
  messages: { role: string; content: string }[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
} {
  return {
    messages: [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      ...request.messages.map((message) => ({ role: message.role, content: message.content }))
    ],
    stream,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens })
  };
}
