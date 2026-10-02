/**
 * @file Stateful composable behind the Chat panel: conversation state, streaming, cancellation, and
 *   handing each completed run to {@link useRun} for cost resolution.
 */

import { computed, ref, shallowRef, type Ref } from 'vue';
import {
  MAX_MESSAGE_CHARACTERS,
  type ChatMessage,
  type ChatStreamEvent
} from '../../../shared/chat';
import type { RunMetrics, RunReceipt } from '../../../shared/runs';
import { useRun, type UseRunOptions } from '../../composables/useRun';
import { ApiError, streamChat } from '../../services/playground-api';
import { newRunId, toRequestMessages, type ConversationTurn } from './conversation';

/**
 * Options for {@link useChat}.
 */
export interface UseChatOptions {
  /**
   * Model identifier to start with, normally the first reviewed Chat model from the catalogue.
   */
  initialModel: string;
  /**
   * Streaming transport, injected so tests drive the event sequence directly instead of over HTTP.
   */
  stream?: typeof streamChat;
  /**
   * Options forwarded to {@link useRun}, so a test can poll without real delays.
   */
  runOptions?: UseRunOptions;
}

/**
 * What the Chat panel binds to.
 */
export interface UseChatResult {
  /**
   * Conversation turns, oldest first.
   */
  turns: Ref<ConversationTurn[]>;
  /**
   * Editable prompt text.
   */
  draft: Ref<string>;
  /**
   * Selected model identifier.
   */
  model: Ref<string>;
  /**
   * Sampling temperature, or `undefined` to use the model default.
   */
  temperature: Ref<number | undefined>;
  /**
   * Whether a run is currently streaming.
   */
  streaming: Ref<boolean>;
  /**
   * Message from the most recent failure, or `null`.
   */
  error: Ref<string | null>;
  /**
   * Receipt of the most recently completed run, or `undefined`.
   */
  receipt: Ref<RunReceipt | undefined>;
  /**
   * Resolved gateway metrics for the most recent run, or `undefined` while unresolved.
   */
  metrics: Ref<RunMetrics | undefined>;
  /**
   * Whether the most recent run's cost is still being polled for.
   */
  costPending: Ref<boolean>;
  /**
   * Whether the draft can be sent: non-empty, within the length limit, and nothing in flight.
   */
  canSend: Ref<boolean>;
  /**
   * Sends the current draft and streams the answer.
   *
   * @returns A promise fulfilled when the run has completed, failed, or been cancelled, and its
   *   cost has been tracked.
   */
  send: () => Promise<void>;
  /**
   * Cancels the run in flight.
   *
   * @returns Nothing; the HTTP request is aborted and the partial answer is kept.
   */
  cancel: () => void;
  /**
   * Clears the conversation, leaving session cost totals untouched.
   *
   * @returns Nothing; the turn list is empty.
   */
  reset: () => void;
}

/**
 * Drives the Chat panel.
 *
 * @param options Initial model, injectable transport, and run-tracking options; see
 *   {@link UseChatOptions}.
 * @returns Reactive conversation state and actions; see {@link UseChatResult}.
 */
export function useChat(options: UseChatOptions): UseChatResult {
  const transport = options.stream ?? streamChat;
  const run = useRun(options.runOptions);

  const turns = ref<ConversationTurn[]>([]);
  const draft = ref('');
  const model = ref(options.initialModel);
  const temperature = ref<number | undefined>(undefined);
  const streaming = ref(false);
  const error = ref<string | null>(null);
  // `shallowRef` because a receipt is replaced wholesale and never mutated field by field.
  const receipt = shallowRef<RunReceipt | undefined>(undefined);

  let controller: AbortController | undefined;

  const canSend = computed(
    () =>
      !streaming.value
      && draft.value.trim() !== ''
      && [...draft.value].length <= MAX_MESSAGE_CHARACTERS
  );

  /**
   * Replaces one turn with an updated copy.
   *
   * The array is rebuilt rather than the turn mutated in place: `turns` is a `ref` over plain
   * objects, and reassignment is what makes the list re-render predictably.
   *
   * @param turnId Turn to update.
   * @param changes Fields to overwrite.
   * @returns Nothing; `turns` now holds the updated turn.
   */
  function updateTurn(turnId: string, changes: Partial<ConversationTurn>): void {
    turns.value = turns.value.map((turn) => (turn.id === turnId ? { ...turn, ...changes } : turn));
  }

  /**
   * Streams one run, applying each event as it arrives.
   *
   * @param messages Conversation to send, captured by the caller before the empty assistant turn
   *   was appended. Passed in rather than read from `turns` here, so the request content does not
   *   depend on when this function happens to run relative to the turn being added.
   * @param runId Run identifier for this request.
   * @param assistantTurnId Turn the generated text is written into.
   * @param signal Abort signal for the request.
   * @returns A promise fulfilled when the stream ends.
   * @throws {ApiError} When the server rejects the request before streaming begins.
   * @throws {DOMException} `AbortError` when the caller cancelled the request.
   */
  async function consume(
    messages: ChatMessage[],
    runId: string,
    assistantTurnId: string,
    signal: AbortSignal
  ): Promise<void> {
    const request = {
      messages,
      model: model.value,
      runId,
      ...(temperature.value === undefined ? {} : { temperature: temperature.value })
    };

    let text = '';
    for await (const event of transport(request, signal)) {
      applyEvent(
        event,
        assistantTurnId,
        () => text,
        (next) => {
          text = next;
        }
      );
    }
  }

  /**
   * Applies one stream event to the panel's state.
   *
   * @param event The event to apply.
   * @param assistantTurnId Turn receiving generated text.
   * @param readText Reads the text accumulated so far.
   * @param writeText Records the newly accumulated text.
   * @returns Nothing; the conversation state reflects the event.
   */
  function applyEvent(
    event: ChatStreamEvent,
    assistantTurnId: string,
    readText: () => string,
    writeText: (next: string) => void
  ): void {
    switch (event.type) {
      case 'start':
        // Nothing to do: the panel already shows the model it asked for, and the event exists so
        // the server confirms which descriptor it resolved.
        break;
      case 'delta': {
        const next = readText() + event.text;
        writeText(next);
        updateTurn(assistantTurnId, { content: next });
        break;
      }
      case 'completed':
        receipt.value = event.receipt;
        break;
      case 'problem':
        error.value = event.detail;
        break;
    }
  }

  return {
    turns,
    draft,
    model,
    temperature,
    streaming,
    error,
    receipt,
    metrics: run.metrics,
    costPending: run.costPending,
    canSend,
    send: async (): Promise<void> => {
      if (!canSend.value) {
        return;
      }

      const prompt = draft.value.trim();
      const runId = newRunId();
      const assistantTurnId = `${runId}-assistant`;

      error.value = null;
      receipt.value = undefined;

      // The user turn is appended before the history is built, so the new prompt is included; the
      // empty assistant turn is appended after, so the model is never asked to continue a blank.
      turns.value = [
        ...turns.value,
        { id: `${runId}-user`, role: 'user', content: prompt, streaming: false }
      ];
      const messages = toRequestMessages(turns.value);

      turns.value = [
        ...turns.value,
        { id: assistantTurnId, role: 'assistant', content: '', streaming: true, runId }
      ];
      draft.value = '';
      streaming.value = true;

      controller = new AbortController();
      const signal = controller.signal;

      try {
        await consume(messages, runId, assistantTurnId, signal);
      } catch (cause) {
        // An abort is the visitor's own Cancel, not a failure, so it leaves no error message. The
        // partial answer stays on screen: it was generated, and it was paid for.
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          error.value =
            cause instanceof ApiError
              ? cause.message
              : 'The answer could not be streamed. Check your connection and try again.';
        }
      } finally {
        streaming.value = false;
        controller = undefined;
        updateTurn(assistantTurnId, { streaming: false });
      }

      // Tracked after the stream settles, because the receipt only exists then. A run that failed
      // or was cancelled before completing has no receipt and contributes nothing to the meter.
      if (receipt.value !== undefined) {
        await run.trackRun(receipt.value);
      }
    },
    cancel: (): void => {
      controller?.abort();
    },
    reset: (): void => {
      turns.value = [];
      receipt.value = undefined;
      error.value = null;
    }
  };
}
