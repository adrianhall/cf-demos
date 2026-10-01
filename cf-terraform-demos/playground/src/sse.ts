/**
 * @file Server-sent events framing, shared by the Worker and the browser. Two different places in
 *   this demo have to read an SSE byte stream: the Worker parses what Workers AI streams back to
 *   it, and the browser parses the typed events the Worker streams onward. Both are the same wire
 *   format, so they share one parser rather than two hand-rolled `split('\n\n')` loops that drift
 *   apart. It lives at `src/` beside `tasks.ts` and `runs.ts` for the same reason: it is a wire
 *   contract with no bindings, no DOM, and no behaviour beyond parsing text. The browser cannot use
 *   `EventSource` for Chat, because `EventSource` only issues `GET` requests and a prompt belongs
 *   in a request body rather than a URL that would end up in logs and history. So the browser reads
 *   a `fetch` response stream and needs this parser too.
 */

/**
 * One parsed server-sent event.
 */
export interface SseFrame {
  /**
   * Value of the `event:` field, or `undefined` for an unnamed event.
   *
   * This demo names every event it emits, but a parser that required the field would reject the
   * unnamed `data:`-only frames Workers AI sends.
   */
  event?: string;
  /**
   * Concatenated `data:` payload. Several `data:` lines in one frame are joined with newlines, as
   * the specification requires, so a multi-line JSON payload survives intact.
   */
  data: string;
}

/**
 * Result of parsing as much of a buffer as is complete.
 */
export interface SseParseResult {
  /**
   * Every frame that was terminated by a blank line in this buffer.
   */
  frames: SseFrame[];
  /**
   * The unterminated remainder, which the caller must prepend to the next chunk.
   *
   * Returned rather than buffered internally so the parser stays a pure function: a stream chunk
   * boundary falls wherever the network puts it, routinely mid-frame and occasionally mid-UTF-8
   * character, and a pure parser makes those cases testable without a stream.
   */
  rest: string;
}

/**
 * Parses the complete frames out of an accumulated SSE buffer.
 *
 * Call it with the previous `rest` plus the newly decoded chunk:
 *
 * ```ts
 * let rest = '';
 * for await (const chunk of chunks) {
 *   const parsed = parseSseBuffer(rest + chunk);
 *   rest = parsed.rest;
 *   for (const frame of parsed.frames) handle(frame);
 * }
 * ```
 *
 * Comment lines beginning `:` are discarded: they are keep-alive padding with no payload, and a
 * caller that saw them as empty data frames would have to filter them itself.
 *
 * @param buffer Everything received and not yet parsed, including any `rest` from the previous
 *   call.
 * @returns The frames completed by a blank line, and the unterminated remainder; see
 *   {@link SseParseResult}.
 */
export function parseSseBuffer(buffer: string): SseParseResult {
  // Normalise line endings first. A chunk can end on the `\r` of a `\r\n` pair, in which case the
  // lone `\r` stays in `rest` and is normalised once its `\n` arrives in the next chunk.
  const normalized = buffer.replaceAll('\r\n', '\n');
  const segments = normalized.split('\n\n');
  // The final segment has no terminating blank line, so it is incomplete by definition.
  const rest = segments.pop() ?? '';

  const frames: SseFrame[] = [];
  for (const segment of segments) {
    const frame = parseFrame(segment);
    if (frame !== undefined) {
      frames.push(frame);
    }
  }

  return { frames, rest };
}

/**
 * Parses one complete frame's worth of lines.
 *
 * @param segment Text of a single frame, without its terminating blank line.
 * @returns The parsed frame, or `undefined` when the segment carried no `data:` field — a
 *   keep-alive comment or stray whitespace, which is not an event.
 */
function parseFrame(segment: string): SseFrame | undefined {
  const dataLines: string[] = [];
  let event: string | undefined;

  for (const line of segment.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    // A single optional space after the colon is part of the framing, not the value.
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'event') {
      event = value;
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  return event === undefined
    ? { data: dataLines.join('\n') }
    : { event, data: dataLines.join('\n') };
}

/**
 * Serialises one named event into SSE wire format.
 *
 * Used by the Worker's stream route. The payload is JSON-encoded, so it never contains a raw
 * newline and can never accidentally terminate its own frame — which is the failure mode of
 * hand-written SSE that streams user-supplied text directly.
 *
 * @param event Event name the browser switches on.
 * @param payload Value to JSON-encode as the frame's `data`.
 * @returns The complete frame text, including its terminating blank line.
 */
export function formatSseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
