/**
 * Pure, DO-runtime-independent collaboration protocol logic for `./diagram-room.ts`: trusted
 * identity header parsing, inbound-frame envelope validation, and the cursor broadcast rate
 * limit. Kept separate from `DiagramRoom` itself (which requires the real Durable Object
 * runtime — SQLite storage, hibernatable WebSockets) so this logic can be unit-tested directly,
 * matching `demos/chat/src/worker/chat-room/validation.ts`'s precedent.
 */
import type {
  CursorSelection,
  Participant,
  ParticipantRole,
} from "../collaboration-protocol";
import {
  CURSOR_BROADCAST_INTERVAL_MS,
  TRUSTED_IDENTITY_HEADER,
  TRUSTED_ROLE_HEADER,
} from "../collaboration-protocol";

/** One parsed, envelope-validated inbound frame, prior to any `kind`-specific operation validation. */
export type ParsedClientFrame =
  | { type: "cursor"; x: number; y: number; selection: CursorSelection | null }
  | { type: "operation"; operation: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a candidate `selection` field.
 *
 * @param value Candidate value — `undefined`/`null` (no selection), or a `{kind, id}` record.
 * @returns The validated selection, `null` when there is none, or `undefined` when `value` is
 * present but does not match the {@link CursorSelection} shape (an invalid-frame signal distinct
 * from "no selection").
 */
function parseSelection(value: unknown): CursorSelection | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { kind, id } = value;
  if (
    (kind !== "node" && kind !== "edge") ||
    typeof id !== "string" ||
    id.length === 0
  ) {
    return undefined;
  }
  return { kind, id };
}

/**
 * Parse and shallow-validate one inbound collaboration frame's envelope.
 *
 * This only routes a frame to the cursor or operation handler and rejects anything that matches
 * neither supported shape — it deliberately does not repeat the full `DurableOperation`
 * validation `../diagrams/operation-input.ts`'s `validateOperationInput` already performs (that
 * happens separately, in `./diagram-room.ts`, once this function has confirmed the frame is at
 * least an `{ "type": "operation", "operation": {...} }` envelope).
 *
 * @param raw Incoming WebSocket message.
 * @returns The parsed frame, or `null` when `raw` is a binary frame, invalid JSON, not an
 * object, has an unsupported `type`, or has a `type: "cursor"` frame with an invalid shape.
 * Callers must close the socket with `MALFORMED_FRAME_CLOSE_CODE` on a `null` result.
 */
export function parseClientFrame(
  raw: string | ArrayBuffer,
): ParsedClientFrame | null {
  if (typeof raw !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  if (parsed.type === "cursor") {
    const { x, y, selection } = parsed;
    if (
      typeof x !== "number" ||
      !Number.isFinite(x) ||
      typeof y !== "number" ||
      !Number.isFinite(y)
    ) {
      return null;
    }
    const parsedSelection = parseSelection(selection);
    if (parsedSelection === undefined) {
      return null;
    }
    return { type: "cursor", x, y, selection: parsedSelection };
  }

  if (parsed.type === "operation" && isRecord(parsed.operation)) {
    return { type: "operation", operation: parsed.operation };
  }

  return null;
}

/**
 * Parse the Worker-injected trusted identity headers.
 *
 * The Durable Object trusts only these two headers, and only because
 * `../worker/routes/diagrams.ts`'s upgrade route deletes any client-supplied value before
 * setting its own verified `Cloudflare_Access_Identity`/`diagram_members` role
 * (`docs/09-ARCHITECT.md`'s Access Model) — this function has no way to and does not attempt to
 * verify that itself; it only checks that both required values are present and well-formed.
 *
 * @param headers Incoming upgrade request headers.
 * @returns The trusted identity, or `null` when either header is missing or the role is not a
 * recognized {@link ParticipantRole}. Reaching `null` here means a request bypassed the Worker
 * entirely — see `MISSING_TRUSTED_IDENTITY_CLOSE_CODE`'s documentation.
 */
export function parseTrustedIdentity(headers: Headers): Participant | null {
  const email = headers.get(TRUSTED_IDENTITY_HEADER);
  const role = headers.get(TRUSTED_ROLE_HEADER);
  if (!email || (role !== "owner" && role !== "editor")) {
    return null;
  }
  return { email, role };
}

/**
 * Decide whether a cursor/selection frame from one connection is allowed to broadcast now, per
 * `docs/09-ARCHITECT.md`'s "Cursor, selection, and drag-preview messages are transient and
 * rate-limited" rule and `spikes/07-architect-collaboration/REPORT.md`'s measured
 * once-per-50ms-per-socket limit.
 *
 * @param lastBroadcastAt The connection's last accepted cursor broadcast time (`Date.now()`
 * epoch milliseconds), read from its socket attachment. `0` for a connection that has never yet
 * broadcast a cursor.
 * @param now The current time (`Date.now()`).
 * @returns Whether enough time has elapsed since `lastBroadcastAt` to allow another broadcast.
 */
export function shouldBroadcastCursor(
  lastBroadcastAt: number,
  now: number,
): boolean {
  return now - lastBroadcastAt >= CURSOR_BROADCAST_INTERVAL_MS;
}
