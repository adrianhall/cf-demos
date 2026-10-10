import type { DocumentationSearchOutcome } from '../../../worker/application/ports/documentation-search.ts';

/**
 * @file The assistant transcript's vocabulary: one entry type and the id generator that keys it. It
 *   sits beside `./types.ts` and `./connect.ts` rather than in a hook, because that is where this
 *   editor keeps the small shared shapes its canvas and its panels both speak — the canvas
 *   (`./DiagramCanvas.tsx`) produces entries from live frames and the panel
 *   (`./panels/AiChatPanel.tsx`) renders them, so neither can own the definition. **A transcript is
 *   presentation state, not document state.** Nothing here reaches `../../stores/diagramStore.ts`,
 *   and that is deliberate rather than incidental: the store's graph is what the whole-graph REST
 *   fallback writes back to D1, so a conversation parked in it would eventually be persisted as
 *   part of somebody's diagram. The same reasoning already keeps presence, cursors and the
 *   remote-change notice out of the store.
 */

/**
 * One line of the assistant conversation, in arrival order.
 *
 * The `id` is local to the tab that produced it — a React list key, and the canvas's own pointer to
 * "the assistant bubble a token should append to". It is never sent, stored or compared across
 * tabs.
 *
 * The six kinds are deliberately not collapsed into a single "message with a role". An action entry
 * is narration of a confirmed graph change that every connected tab could render; a docs result
 * carries structure a sentence could not; and an error is a turn that ended. Flattening them would
 * mean reconstructing the distinction at render time from the text itself.
 */
export type ChatTranscriptEntry = { id: string } & (
  | {
      /**
       * Discriminator: a message the person typed.
       */
      kind: 'user';
      /**
       * Exactly what they typed, rendered verbatim rather than as Markdown.
       */
      text: string;
    }
  | {
      /**
       * Discriminator: a bubble of the assistant's own prose.
       */
      kind: 'assistant';
      /**
       * The answer so far, accumulated from `chat_token` frames and rendered as Markdown.
       */
      text: string;
      /**
       * Whether the reader stopped watching this turn, so the bubble is left exactly as they last
       * saw it instead of being completed under them.
       */
      stopped: boolean;
    }
  | {
      /**
       * Discriminator: a `chat_status` progress narration.
       */
      kind: 'status';
      /**
       * The session's own wording, shown verbatim.
       */
      text: string;
    }
  | {
      /**
       * Discriminator: narration of one confirmed `operation_applied` broadcast.
       */
      kind: 'action';
      /**
       * Short description of the change; see `../../lib/describe-operation.ts`.
       */
      text: string;
    }
  | {
      /**
       * Discriminator: the outcome of a documentation lookup the assistant performed.
       */
      kind: 'docs_result';
      /**
       * The query the assistant chose, so a reader sees what was asked on their behalf.
       */
      query: string;
      /**
       * The matching pages, or the non-fatal "unavailable" outcome.
       */
      outcome: DocumentationSearchOutcome;
    }
  | {
      /**
       * Discriminator: a turn that failed.
       */
      kind: 'error';
      /**
       * User-safe explanation from the `chat_error` frame.
       */
      text: string;
    }
);

/**
 * Monotonic counter behind {@link nextTranscriptEntryId}.
 *
 * A plain module-level number rather than `crypto.randomUUID()`: the value only has to be unique
 * within one tab's transcript, it is read in render as a list key, and a counter makes a failing
 * test's output legible in a way a UUID does not.
 */
let transcriptEntryCounter = 0;

/**
 * Mints the next transcript entry id.
 *
 * @returns An id unique within this tab for the lifetime of the page.
 */
export function nextTranscriptEntryId(): string {
  transcriptEntryCounter += 1;
  return `chat-entry-${transcriptEntryCounter}`;
}
