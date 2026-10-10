/**
 * @file A minimal Server-Sent Events frame decoder, shared by both directions of this demo's
 * streaming: the Worker reading a Workers AI model's raw SSE byte stream
 * (`src/worker/chat/inference.ts`), and the browser reading this Worker's own re-emitted SSE
 * stream (`src/client/lib/stream-reader.ts`). Implementing frame-splitting once here, instead of
 * once per direction, is deliberate — see docs/05-AI-CHAT.md, "Streaming Protocol".
 *
 * `env.AI.run(model, { stream: true })` resolves to `Promise<ReadableStream>` of **raw SSE
 * bytes**, not an async iterable of parsed objects (a common misconception from older examples —
 * see docs/05-AI-CHAT.md). Callers must decode UTF-8, buffer across chunk boundaries, split
 * frames on a blank line, and strip the `data:` prefix themselves; this module does exactly that
 * and nothing else. It does not `JSON.parse` — callers own that, since the Worker's own frames
 * (`ChatStreamFrame`) and Workers AI's raw chunk JSON have different, independently-typed shapes.
 */

/**
 * Extract the joined `data:` payload from one raw SSE frame (the text between two blank lines).
 * Per the SSE spec, multiple `data:` lines in one frame are joined with `\n`; exactly one leading
 * space after the colon is stripped when present. Non-`data:` lines (e.g. `event:`, `id:`,
 * comments starting with `:`) are ignored — neither producer in this demo sends them, but a
 * silent ignore is safer than throwing on a field this decoder doesn't need.
 *
 * @param rawFrame Frame text with its trailing blank line already removed.
 * @returns The joined payload, or `undefined` when the frame has no `data:` line at all (for
 * example a frame consisting only of a comment or another field this decoder ignores).
 */
function extractDataPayload(rawFrame: string): string | undefined {
  const dataLines = rawFrame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /u, ""));
  return dataLines.length === 0 ? undefined : dataLines.join("\n");
}

/**
 * Decode a raw SSE byte stream into an async sequence of `data:` payload strings.
 *
 * Handles the two edge cases that make hand-rolled SSE parsing bug-prone: a frame boundary
 * (`\n\n`) split across two separate stream chunks (held in an internal buffer across `read()`
 * calls), and a final frame with no trailing blank line (flushed once the stream closes). The
 * literal string `"[DONE]"` — the sentinel both Workers AI and this Worker's own re-emitted
 * stream use to mark the end of a turn — is yielded like any other payload; callers recognize it
 * by value, not by any special decoder behavior.
 *
 * If the caller stops iterating early (a `for await` loop `break`s, or the generator's `return()`
 * is called), the underlying reader is cancelled in a `finally` block — this is what lets a
 * cancelled outgoing response stream (`src/worker/chat/stream.ts`) propagate cancellation all the
 * way to the upstream Workers AI reader, so an abandoned generation actually stops instead of
 * continuing to run (and bill) unread.
 *
 * @param stream Raw byte stream — either a Workers AI model's `env.AI.run()` result, or this
 * Worker's own outgoing response body as observed by the browser.
 * @returns An async generator yielding each frame's `data:` payload, in order.
 */
export async function* decodeSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const rawFrame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const payload = extractDataPayload(rawFrame);
        if (payload !== undefined) {
          yield payload;
        }
        separatorIndex = buffer.indexOf("\n\n");
      }
    }

    // Flush a trailing frame that never received a closing blank line (some producers omit the
    // final one before closing the stream).
    buffer += decoder.decode();
    const trailingPayload = extractDataPayload(buffer);
    if (trailingPayload !== undefined) {
      yield trailingPayload;
    }
  } finally {
    // Cancelling an already-fully-read stream is a harmless no-op; cancelling a still-open one
    // is what stops upstream Workers AI generation when a consumer abandons iteration early.
    await reader.cancel().catch(() => undefined);
  }
}
