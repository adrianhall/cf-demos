/** Opening marker for an inline reasoning block. */
const OPEN_MARKER = "<think>";

/** Closing marker for an inline reasoning block. */
const CLOSE_MARKER = "</think>";

/** The answer and reasoning text extracted from one chunk of input. Either may be empty. */
export interface ThinkTagSplitResult {
  readonly answer: string;
  readonly thinking: string;
}

/**
 * A stateful splitter for models using the `reasoning: "inline-think-tags"` mechanism
 * (`src/models.ts` — currently DeepSeek R1 Distill), which emits reasoning inline in its answer
 * text between literal `<think>`/`</think>` markers rather than in a separate JSON field. Create
 * one instance per turn with {@link createThinkTagSplitter} and feed it every `answerDelta` an
 * adapter's `readChunk()` produces, in order.
 */
export interface ThinkTagSplitter {
  /**
   * Feed the next chunk of raw model text.
   *
   * @param chunk Raw text, exactly as received from the adapter — may contain a complete marker,
   * part of a marker, several markers, or no markers at all.
   * @returns The text to emit as answer and as thinking for this chunk. Either may be empty.
   */
  push(chunk: string): ThinkTagSplitResult;
  /**
   * Flush any text held back waiting to see whether it completed a marker. Call this once, after
   * the upstream stream ends (`[DONE]`).
   *
   * @returns Any remaining held-back text. If the splitter was mid-`<think>` block when the
   * stream ended (the model was cut off, for example by `maxTokens`, before emitting
   * `</think>`), the remainder is flushed as **thinking**, not dropped and not misfiled as
   * answer. Otherwise, held-back text was only ever a false-alarm partial `<think>` prefix that
   * never completed, and is flushed as **answer**.
   */
  flush(): ThinkTagSplitResult;
}

/**
 * Find the longest suffix of `text` that is also a prefix of `marker` (excluding a full match of
 * `marker` itself, which the caller already checked for with `indexOf`). This is what lets the
 * splitter hold back a partial marker — for example `"<th"` at the end of a chunk — instead of
 * emitting it as ordinary text and then failing to recognize `"ink>"` when it arrives in the next
 * chunk.
 *
 * @param text Text to search for a trailing partial marker.
 * @param marker The complete marker being watched for (`<think>` or `</think>`).
 * @returns The length of the longest such suffix, or `0` when none of `text`'s suffixes match any
 * non-empty prefix of `marker`.
 */
function longestMarkerPrefixSuffix(text: string, marker: string): number {
  const maxLength = Math.min(text.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

/**
 * Create a new {@link ThinkTagSplitter}. Each instance tracks its own `inThink` state and
 * held-back partial-marker buffer, so a new instance is required per turn — never share one
 * across concurrent requests.
 *
 * This is a pure state machine with no I/O, chosen deliberately so it can be unit-tested
 * exhaustively (docs/05-AI-CHAT.md calls this the demo's highest-defect-risk module) without any
 * real or fake model.
 *
 * @returns A fresh splitter, starting outside a `<think>` block.
 */
export function createThinkTagSplitter(): ThinkTagSplitter {
  let inThink = false;
  let pending = "";

  function push(chunk: string): ThinkTagSplitResult {
    let text = pending + chunk;
    pending = "";
    let answer = "";
    let thinking = "";

    for (;;) {
      const marker = inThink ? CLOSE_MARKER : OPEN_MARKER;
      const markerIndex = text.indexOf(marker);

      if (markerIndex === -1) {
        const holdLength = longestMarkerPrefixSuffix(text, marker);
        const emitted = text.slice(0, text.length - holdLength);
        pending = text.slice(text.length - holdLength);
        if (inThink) {
          thinking += emitted;
        } else {
          answer += emitted;
        }
        break;
      }

      const before = text.slice(0, markerIndex);
      if (inThink) {
        thinking += before;
      } else {
        answer += before;
      }
      inThink = !inThink;
      text = text.slice(markerIndex + marker.length);
    }

    return { answer, thinking };
  }

  function flush(): ThinkTagSplitResult {
    const remaining = pending;
    pending = "";
    if (remaining.length === 0) {
      return { answer: "", thinking: "" };
    }
    // An unclosed <think> at end of stream is flushed as thinking, not dropped (see this
    // function's docs); otherwise `remaining` was only ever a false-alarm partial marker prefix.
    return inThink
      ? { answer: "", thinking: remaining }
      : { answer: remaining, thinking: "" };
  }

  return { push, flush };
}
