import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';
import type { ChatMessageFrame, ClientFrame, OperationFrame } from '../../live-sync-protocol.ts';
import type { GraphOperation } from './graph-operations.ts';

/**
 * @file Validation for frames arriving over a WebSocket — the one place a diagram session accepts
 *   input from a browser. It is in `domain/` rather than beside the Durable Object for the same
 *   reason the graph validation is: it is a rule about what the application accepts, not a detail
 *   of the transport that delivered it, and it must be testable without a runtime. The session is
 *   where an invalid frame is _answered_; this is where "invalid" is defined. **Why a hand-written
 *   parser rather than a type assertion.** `JSON.parse` returns `any`, and casting that to
 *   `ClientFrame` would make every field below a lie the compiler cannot catch — a frame claiming
 *   `kind: 'remove_node'` with no `nodeId` would reach the graph mutations as `undefined` and
 *   remove nothing while reporting success. This is a trust boundary, and the type has to be earned
 *   rather than asserted. **Why it rejects an author field outright.** The wire protocol has no
 *   field for a client to say who it is: the session attributes every operation to the identity
 *   pinned to the socket. A payload that carries one is either a confused client or a probe, and
 *   either way the useful response is to refuse it rather than to ignore the field quietly —
 *   ignoring it would leave the protocol looking as though it might one day honour it.
 */

/**
 * Field names a client must never send on an operation.
 *
 * Attribution comes from the socket's verified identity and nothing else. These are refused rather
 * than stripped so that an attempt is visible to the client that made it, and so a reader of this
 * list can see exactly what the protocol declines to take on trust.
 */
const FORBIDDEN_OPERATION_FIELDS = ['actor', 'author', 'viewer', 'origin', 'ownerEmail'];

/**
 * Field names a client must never send on a chat message.
 *
 * The same rule as {@link FORBIDDEN_OPERATION_FIELDS}, and it matters more here rather than less. A
 * chat turn applies operations attributed to the connection's own identity, so a frame naming an
 * actor is asking the assistant to make changes in somebody else's name. `messages` and `history`
 * are refused alongside the attribution fields because the transcript is the session's, held per
 * connection: a client that could supply one could fabricate an exchange in which the assistant had
 * already agreed to something.
 */
const FORBIDDEN_CHAT_FIELDS = [
  'actor',
  'author',
  'viewer',
  'origin',
  'ownerEmail',
  'messages',
  'history'
];

/**
 * Longest chat message this session accepts, in characters.
 *
 * A bound rather than a judgement about what somebody might reasonably type: the text is sent to a
 * paid inference call that is re-sent on every round of the turn, so an unbounded field is an
 * unbounded cost. Eight thousand characters is several pages of prose, well beyond any real
 * request, and it mirrors the 8 KiB default `@demos/worker-common`'s `jsonBodyLimit()` applies to
 * the HTTP side of this application.
 */
const MAX_CHAT_MESSAGE_LENGTH = 8_000;

/**
 * Reports whether a value is a plain JSON object.
 *
 * Arrays and `null` are excluded explicitly: both are `typeof 'object'`, so a naive check would let
 * `[]` or `null` reach property access and produce a confusing error about a missing field rather
 * than a clear one about the value's shape.
 *
 * @param value Candidate value.
 * @returns `true` when the value is a non-null, non-array object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a required non-empty string field.
 *
 * @param source Object to read from.
 * @param field Field name, used verbatim in the error so a client is told which field to fix.
 * @returns The field's value.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the field is absent, not a string, or
 *   empty. An empty id is refused because it would address nothing while looking like an address.
 */
function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest({ detail: `${field} must be a non-empty string.` });
  }
  return value;
}

/**
 * Reads an optional string field.
 *
 * @param source Object to read from.
 * @param field Field name, used verbatim in the error.
 * @returns The field's value, or `undefined` when absent.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the field is present but not a string.
 *   Present-but-wrong is refused rather than treated as absent: a client that sent a number for a
 *   label meant to set something, and silently dropping it would lose the edit.
 */
function optionalString(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw badRequest({ detail: `${field} must be a string.` });
  }
  return value;
}

/**
 * Reads an optional plain-object field.
 *
 * @param source Object to read from.
 * @param field Field name, used verbatim in the error.
 * @returns A shallow copy of the field, or `undefined` when absent. Copying keeps the validated
 *   operation independent of the parsed payload a caller could still hold.
 * @throws {ProblemDetailsError} `badRequest()` (400) when present but not an object.
 */
function optionalObject(
  source: Record<string, unknown>,
  field: string
): Record<string, unknown> | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw badRequest({ detail: `${field} must be an object.` });
  }
  return { ...value };
}

/**
 * Reads an optional string-or-null field.
 *
 * @param source Object to read from.
 * @param field Field name, used verbatim in the error.
 * @returns The string or `null`, or `undefined` when absent.
 * @throws {ProblemDetailsError} `badRequest()` (400) when present but neither a string nor `null`.
 */
function optionalNullableString(
  source: Record<string, unknown>,
  field: string
): string | null | undefined {
  const value = source[field];
  if (value === undefined || value === null || typeof value === 'string') {
    return value;
  }
  throw badRequest({ detail: `${field} must be a string or null.` });
}

/**
 * Reads a required `{ x, y }` position.
 *
 * @param source Object to read from.
 * @param field Field name holding the position.
 * @returns The position.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the field is absent or either coordinate
 *   is not a finite number. `NaN` and `Infinity` are refused explicitly: both survive a `typeof
 *   'number'` check and both place a node where React Flow cannot draw it.
 */
function requirePosition(source: Record<string, unknown>, field: string): { x: number; y: number } {
  const value = source[field];
  if (!isPlainObject(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw badRequest({ detail: `${field} must be { x, y } finite numbers.` });
  }
  return { x: value.x as number, y: value.y as number };
}

/**
 * Reads an optional `{ x, y }` position.
 *
 * @param source Object to read from.
 * @param field Field name holding the position.
 * @returns The position, or `undefined` when absent.
 * @throws {ProblemDetailsError} `badRequest()` (400) when present but malformed.
 */
function optionalPosition(
  source: Record<string, unknown>,
  field: string
): { x: number; y: number } | undefined {
  return source[field] === undefined ? undefined : requirePosition(source, field);
}

/**
 * Reads one selection identifier, where `null` deliberately means the sender cleared it.
 *
 * @param source Object to read from.
 * @param field Selection field name.
 * @returns The selected id or `null`.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the field is missing or malformed.
 */
function requireNullableString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw badRequest({ detail: `${field} must be a string or null.` });
}

/**
 * Validates the operation payload of an inbound frame.
 *
 * Each branch builds a fresh object field by field rather than passing the parsed value through.
 * That is what stops an unexpected property riding along into the stored graph: the result contains
 * exactly what this function put in it.
 *
 * @param value Parsed `operation` value from the frame.
 * @returns The validated operation.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the value is not an object, names no
 *   known operation kind, carries a field reserved for server attribution, or is missing or
 *   malformed in any field its kind requires.
 */
function validateOperation(value: unknown): GraphOperation {
  if (!isPlainObject(value)) {
    throw badRequest({ detail: 'operation must be an object.' });
  }

  for (const field of FORBIDDEN_OPERATION_FIELDS) {
    if (value[field] !== undefined) {
      throw badRequest({
        detail:
          `operation must not carry "${field}": a change is attributed to the connection it `
          + 'arrived on.'
      });
    }
  }

  const kind = value.kind;
  switch (kind) {
    case 'add_node': {
      const input = isPlainObject(value.input) ? value.input : {};
      const style = optionalObject(input, 'style');
      return {
        input: {
          ...(optionalString(input, 'id') === undefined ? {} : { id: input.id as string }),
          ...(optionalString(input, 'description') === undefined
            ? {}
            : { description: input.description as string }),
          label: requireString(input, 'label'),
          position: requirePosition(input, 'position'),
          ...(style === undefined ? {} : { style }),
          typeId: requireString(input, 'typeId')
        },
        kind: 'add_node'
      };
    }
    case 'update_node': {
      const patch = isPlainObject(value.patch) ? value.patch : {};
      const position = optionalPosition(patch, 'position');
      const style = optionalObject(patch, 'style');
      return {
        kind: 'update_node',
        nodeId: requireString(value, 'nodeId'),
        patch: {
          ...(optionalString(patch, 'label') === undefined ? {} : { label: patch.label as string }),
          ...(optionalString(patch, 'description') === undefined
            ? {}
            : { description: patch.description as string }),
          ...(position === undefined ? {} : { position }),
          ...(style === undefined ? {} : { style })
        }
      };
    }
    case 'remove_node':
      return { kind: 'remove_node', nodeId: requireString(value, 'nodeId') };
    case 'add_edge': {
      const input = isPlainObject(value.input) ? value.input : {};
      const sourceHandle = optionalNullableString(input, 'sourceHandle');
      const targetHandle = optionalNullableString(input, 'targetHandle');
      return {
        input: {
          ...(optionalString(input, 'id') === undefined ? {} : { id: input.id as string }),
          ...(optionalString(input, 'label') === undefined ? {} : { label: input.label as string }),
          ...(optionalString(input, 'description') === undefined
            ? {}
            : { description: input.description as string }),
          ...(optionalString(input, 'protocol') === undefined
            ? {}
            : { protocol: input.protocol as string }),
          edgeType: requireString(input, 'edgeType'),
          source: requireString(input, 'source'),
          ...(sourceHandle === undefined ? {} : { sourceHandle }),
          target: requireString(input, 'target'),
          ...(targetHandle === undefined ? {} : { targetHandle })
        },
        kind: 'add_edge'
      };
    }
    case 'update_edge': {
      const patch = isPlainObject(value.patch) ? value.patch : {};
      return {
        edgeId: requireString(value, 'edgeId'),
        kind: 'update_edge',
        patch: {
          ...(optionalString(patch, 'edgeType') === undefined
            ? {}
            : { edgeType: patch.edgeType as string }),
          ...(optionalString(patch, 'label') === undefined ? {} : { label: patch.label as string }),
          ...(optionalString(patch, 'description') === undefined
            ? {}
            : { description: patch.description as string }),
          ...(optionalString(patch, 'protocol') === undefined
            ? {}
            : { protocol: patch.protocol as string })
        }
      };
    }
    case 'remove_edge':
      return { edgeId: requireString(value, 'edgeId'), kind: 'remove_edge' };
    case 'auto_layout':
      return { kind: 'auto_layout' };
    default:
      throw badRequest({ detail: `Unknown operation kind "${String(kind)}".` });
  }
}

/**
 * Validates an inbound chat message frame.
 *
 * @param parsed The decoded frame object.
 * @returns The validated frame.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the frame carries a field reserved for
 *   server attribution or for the session's own transcript, when `clientRequestId` or `text` is
 *   absent or empty, or when the text exceeds {@link MAX_CHAT_MESSAGE_LENGTH}. An empty message is
 *   refused rather than sent: it would spend an inference call asking the model to respond to
 *   nothing.
 */
function validateChatMessage(parsed: Record<string, unknown>): ChatMessageFrame {
  for (const field of FORBIDDEN_CHAT_FIELDS) {
    if (parsed[field] !== undefined) {
      throw badRequest({
        detail:
          `A chat message must not carry "${field}": a turn is attributed to the connection it `
          + 'arrived on, and its transcript belongs to the session.'
      });
    }
  }

  const text = requireString(parsed, 'text');
  if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw badRequest({
      detail: `text must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters.`
    });
  }

  return {
    clientRequestId: requireString(parsed, 'clientRequestId'),
    text,
    type: 'chat_message'
  };
}

/**
 * Parses and validates one raw frame a client sent over a live session socket.
 *
 * @param raw Raw frame payload as it arrived.
 * @returns The validated frame, whose type is now earned rather than asserted.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the payload is not a string, does not
 *   contain JSON, is not an object, names no known frame type, or fails any check its type
 *   requires. Binary frames are refused along with everything else: this protocol is JSON, and a
 *   client sending bytes has misunderstood it rather than found a second encoding.
 */
export function parseClientFrame(raw: string | ArrayBuffer): ClientFrame {
  if (typeof raw !== 'string') {
    throw badRequest({ detail: 'A frame must be JSON text.' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest({ detail: 'A frame must contain valid JSON.' });
  }

  if (!isPlainObject(parsed)) {
    throw badRequest({ detail: 'A frame must be a JSON object.' });
  }

  switch (parsed.type) {
    case 'operation':
      return {
        operation: validateOperation(parsed.operation),
        operationId: requireString(parsed, 'operationId'),
        type: 'operation'
      } satisfies OperationFrame;
    case 'chat_message':
      return validateChatMessage(parsed);
    case 'resync':
      return { type: 'resync' };
    case 'cursor_moved':
      if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) {
        throw badRequest({ detail: 'x and y must be finite numbers.' });
      }
      return { type: 'cursor_moved', x: parsed.x as number, y: parsed.y as number };
    case 'selection_changed': {
      const edgeId = requireNullableString(parsed, 'edgeId');
      const nodeId = requireNullableString(parsed, 'nodeId');
      if (nodeId !== null && edgeId !== null) {
        throw badRequest({
          detail: 'A selection may name a node, an edge, or neither, but not both.'
        });
      }
      return { edgeId, nodeId, type: 'selection_changed' };
    }
    default:
      throw badRequest({ detail: `Unknown frame type "${String(parsed.type)}".` });
  }
}
