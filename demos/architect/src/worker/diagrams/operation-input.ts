import { unprocessableContent } from "@adrianhall/cloudflare-toolkit/errors";
import { OPERATION_KINDS } from "../../graph/operations";
import type {
  AddEdgePayload,
  AddNodePayload,
  DeleteEdgePayload,
  DeleteNodePayload,
  DurableOperation,
  MoveNodePayload,
  OperationKind,
  ReplaceDocumentPayload,
  UpdateNodePayload,
} from "../../graph/operations";

const MAX_OPERATION_ID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Check the minimal required fields for each {@link OperationKind}'s payload.
 *
 * This is intentionally shallow — it exists only to reject an obviously malformed request body
 * with a clear `422` before it reaches `DiagramRoom`. Full node/edge shape and catalog/reference
 * validation happens once, document-wide, inside the Durable Object via
 * `validateGraphDocument` after the operation is tentatively applied.
 *
 * @param kind Validated operation kind.
 * @param payload Candidate payload object.
 * @throws {ProblemDetailsError} When a required field for `kind` is missing or the wrong type.
 */
function validatePayloadShape(
  kind: OperationKind,
  payload: Record<string, unknown>,
): void {
  const fail = (detail: string): never => {
    throw unprocessableContent({ detail });
  };
  switch (kind) {
    case "add_node":
      if (!isRecord(payload.node)) fail("payload.node must be an object.");
      return;
    case "update_node":
      if (!isNonEmptyString(payload.nodeId)) {
        fail("payload.nodeId must be a non-empty string.");
      }
      if (!isRecord(payload.data)) fail("payload.data must be an object.");
      return;
    case "move_node": {
      if (!isNonEmptyString(payload.nodeId)) {
        fail("payload.nodeId must be a non-empty string.");
      }
      const position = payload.position;
      if (
        !isRecord(position) ||
        typeof position.x !== "number" ||
        typeof position.y !== "number"
      ) {
        fail("payload.position must be a numeric x/y object.");
      }
      return;
    }
    case "delete_node":
      if (!isNonEmptyString(payload.nodeId)) {
        fail("payload.nodeId must be a non-empty string.");
      }
      return;
    case "add_edge":
      if (!isRecord(payload.edge)) fail("payload.edge must be an object.");
      return;
    case "delete_edge":
      if (!isNonEmptyString(payload.edgeId)) {
        fail("payload.edgeId must be a non-empty string.");
      }
      return;
    case "replace_document":
      if (!isRecord(payload.document)) {
        fail("payload.document must be an object.");
      }
      return;
    default: {
      const exhaustive: never = kind;
      fail(`Unsupported operation kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Validate an untrusted request body as a {@link DurableOperation} envelope before it is ever
 * forwarded to `DiagramRoom.applyOperation`.
 *
 * @param value Parsed JSON body.
 * @returns Validated operation envelope.
 * @throws {ProblemDetailsError} When the envelope's own fields or `kind`-specific payload shape
 * are invalid.
 */
export function validateOperationInput(value: unknown): DurableOperation {
  if (!isRecord(value)) {
    throw unprocessableContent({
      detail: "The request body must be an object.",
    });
  }
  const { operationId, baseRevision, kind, payload } = value;
  if (
    !isNonEmptyString(operationId) ||
    operationId.length > MAX_OPERATION_ID_LENGTH
  ) {
    throw unprocessableContent({
      detail: "operationId must be a non-empty string.",
    });
  }
  if (
    typeof baseRevision !== "number" ||
    !Number.isInteger(baseRevision) ||
    baseRevision < 0
  ) {
    throw unprocessableContent({
      detail: "baseRevision must be a non-negative integer.",
    });
  }
  if (
    typeof kind !== "string" ||
    !OPERATION_KINDS.includes(kind as OperationKind)
  ) {
    throw unprocessableContent({
      detail: "kind must be a supported operation kind.",
    });
  }
  if (!isRecord(payload)) {
    throw unprocessableContent({ detail: "payload must be an object." });
  }
  const validatedKind = kind as OperationKind;
  validatePayloadShape(validatedKind, payload);

  // A `switch` per kind (rather than one shared cast) keeps each branch's payload assertion a
  // single, narrow `as SpecificPayload` — `validatePayloadShape` already confirmed the required
  // fields exist for `validatedKind` above, so this only tells the type system what the shallow
  // shape check already proved at runtime.
  switch (validatedKind) {
    case "add_node":
      return {
        operationId,
        baseRevision,
        kind: validatedKind,
        payload: payload as unknown as AddNodePayload,
      };
    case "update_node":
      return {
        operationId,
        baseRevision,
        kind: validatedKind,
        payload: payload as unknown as UpdateNodePayload,
      };
    case "move_node":
      return {
        operationId,
        baseRevision,
        kind: validatedKind,
        payload: payload as unknown as MoveNodePayload,
      };
    case "delete_node":
      return {
        operationId,
        baseRevision,
        kind: validatedKind,
        payload: payload as unknown as DeleteNodePayload,
      };
    case "add_edge":
      return {
        operationId,
        baseRevision,
        kind: validatedKind,
        payload: payload as unknown as AddEdgePayload,
      };
    case "delete_edge":
      return {
        operationId,
        baseRevision,
        kind: validatedKind,
        payload: payload as unknown as DeleteEdgePayload,
      };
    case "replace_document":
      return {
        operationId,
        baseRevision,
        kind: validatedKind,
        payload: payload as unknown as ReplaceDocumentPayload,
      };
    default: {
      const exhaustive: never = validatedKind;
      throw unprocessableContent({
        detail: `Unsupported operation kind: ${String(exhaustive)}`,
      });
    }
  }
}
