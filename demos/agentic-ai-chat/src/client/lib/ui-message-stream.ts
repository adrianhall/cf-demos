/**
 * @file Decoder for the `AIChatAgent` WebSocket wire protocol's `cf_agent_use_chat_response`
 * frame body, reverse-engineered and confirmed live by Spike A
 * (`spikes/00-aichatagent-basics/REPORT.md` Section 5). Neither `agents/react`'s `useAgentChat`
 * nor any framework-agnostic equivalent is exported for driving a chat turn, so this demo's Vue
 * composable (`../composables/useChatAgent.ts`) hand-builds the client side of the protocol; this
 * module is the one piece of that reverse-engineered wire format that benefits from its own,
 * directly unit-testable decoder rather than being inlined into the composable.
 *
 * The frame's `body` is **not** classic `data: {...}\n\n` SSE framing -- it is the raw
 * `toUIMessageStreamResponse()` body text forwarded byte-for-byte, and arrives as bare,
 * back-to-back JSON objects with no `data:`/`event:` prefix and no guaranteed separator between
 * them (Spike A, Section 5). A chunk boundary can also split one JSON object across two separate
 * `body` deltas. `UiMessageStreamDecoder` buffers across both without assuming SSE framing.
 */

/** One parsed AI SDK v5 UI-message-stream part. Only the fields this demo's Phase 2 transcript
 * actually reads are typed narrowly; every other part shape decodes as `UnknownStreamPart`. */
export type UiStreamPart =
  | { type: "start" }
  | { type: "start-step" }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "finish-step" }
  | { type: "finish" }
  | { type: "error"; errorText: string }
  | UnknownStreamPart;

/** A recognized-shape part this demo does not otherwise act on (for example a future tool-call
 * part, from Phase 9/10 onward) -- decoded, not dropped, so a caller can still inspect it. */
export interface UnknownStreamPart {
  type: string;
  [key: string]: unknown;
}

/**
 * Find the index of the closing `}` that matches the opening `{` at `text[start]`, tracking
 * string literals (and their escapes) so a brace character inside a string value is never
 * mistaken for structural JSON. Array brackets need no separate tracking: JSON's brace nesting
 * is well-formed regardless of any `[`/`]` surrounding it.
 *
 * @param text Buffer to scan.
 * @param start Index of the object's opening `{`.
 * @returns The index of the matching `}`, or `-1` if the object is not yet complete in `text`.
 */
function findObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Incrementally decodes a sequence of raw `cf_agent_use_chat_response` `body` chunks into
 * complete UI-message-stream parts, buffering any partial trailing object across `push()` calls.
 * One instance is created per in-flight chat turn (a fresh `id` in the wire protocol).
 */
export class UiMessageStreamDecoder {
  private buffer = "";

  /**
   * Feed one raw `body` chunk (may contain zero, one, or several complete JSON objects, and may
   * end mid-object).
   *
   * @param chunk Raw chunk text from a `cf_agent_use_chat_response` frame.
   * @returns Every UI-message-stream part that became complete as a result of this chunk, in
   * arrival order. Returns an empty array when `chunk` only extends an already-buffered partial
   * object.
   */
  push(chunk: string): UiStreamPart[] {
    this.buffer += chunk;
    const parts: UiStreamPart[] = [];
    let index = 0;

    for (;;) {
      while (index < this.buffer.length && /\s/u.test(this.buffer[index])) {
        index += 1;
      }
      if (index >= this.buffer.length || this.buffer[index] !== "{") {
        break;
      }
      const end = findObjectEnd(this.buffer, index);
      if (end === -1) {
        break;
      }
      const raw = this.buffer.slice(index, end + 1);
      try {
        parts.push(JSON.parse(raw) as UiStreamPart);
      } catch {
        // A malformed object should never occur against a real `toUIMessageStreamResponse()`
        // body; skip it defensively rather than throwing and losing every part already decoded.
      }
      index = end + 1;
    }

    this.buffer = this.buffer.slice(index);
    return parts;
  }
}
