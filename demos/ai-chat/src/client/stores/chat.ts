import { defineStore } from "pinia";
import { computed, shallowRef } from "vue";
import type {
  ChatMessage,
  ChatRequestBody,
  ChatStreamFrame,
  UsageInfo,
} from "../../chat-protocol";
import { ChatResponseError, readChatStream } from "../lib/stream-reader";
import { useSettingsStore } from "./settings";

/** Lifecycle of one submitted conversation turn. */
export type TurnStatus = "streaming" | "done" | "stopped" | "error";

/**
 * One turn of the conversation as held entirely in the browser tab — the Worker keeps no state
 * between requests (see docs/05-AI-CHAT.md). Records the exact model and parameters used for
 * *this* turn, independent of the settings store's *current* selection, since the model may
 * change mid-conversation (docs/05-AI-CHAT.md, Phase 4, task 19).
 */
export interface ChatTurn {
  /** Client-generated identifier, stable for the life of this turn. */
  readonly id: string;
  /** Exact catalog model ID used for this turn. */
  readonly modelId: string;
  /** Display name captured at submit time, so a later catalog change can't relabel history. */
  readonly modelDisplayName: string;
  /** Sampling temperature actually sent for this turn. */
  readonly temperature: number;
  /** Output token limit actually sent for this turn. */
  readonly maxTokens: number;
  /** The user's submitted turn content. */
  readonly userContent: string;
  /** Accumulated answer text streamed so far. */
  readonly answer: string;
  /** Accumulated reasoning text streamed so far, or `""` when the model produced none. */
  readonly thinking: string;
  /** Current lifecycle state. */
  readonly status: TurnStatus;
  /** Time to first token, in milliseconds, once known. */
  readonly ttftMs: number | null;
  /** Total turn duration, in milliseconds, once known. */
  readonly totalMs: number | null;
  /** Normalized token usage, or `null` when unknown or unreported. */
  readonly usage: UsageInfo | null;
  /** `"stop"`, `"length"`, `"cancelled"`, or a model-reported value, once known. */
  readonly finishReason: string | null;
  /** Problem-details message for a turn that ended in `"error"`. */
  readonly errorDetail: string | null;
}

/**
 * `true` for the `AbortError` a cancelled `fetch()`/stream read rejects with.
 *
 * `DOMException` is checked separately from `Error`: in a real browser and in jsdom (this
 * store's `client` Vitest project), `DOMException` does **not** extend `Error`, while in Node's
 * native `fetch()` implementation it does — so neither check alone is portable.
 */
function isAbortError(cause: unknown): boolean {
  if (cause instanceof DOMException) {
    return cause.name === "AbortError";
  }
  return cause instanceof Error && cause.name === "AbortError";
}

/** Build the next request's conversation from prior turns plus the new user turn. */
function buildConversation(
  turns: readonly ChatTurn[],
  newUserContent: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    messages.push({ role: "user", content: turn.userContent });
    // A turn that never produced any answer text (an immediate error, or stopped before the
    // first token) has nothing valid to replay as an assistant turn — the Worker rejects an
    // empty message content, and there is nothing meaningful to show the model as its own past
    // reply anyway.
    if (turn.answer.length > 0) {
      messages.push({ role: "assistant", content: turn.answer });
    }
  }
  messages.push({ role: "user", content: newUserContent });
  return messages;
}

/**
 * Owns the entire visible conversation, one turn's in-flight streaming state, and the
 * `AbortController` that lets the Stop control cancel upstream inference rather than merely
 * hiding it (see docs/05-AI-CHAT.md, "Streaming Protocol"). The Worker is stateless: every
 * `submit()` call resends the full conversation built from {@link turns}.
 */
export const useChatStore = defineStore("chat", () => {
  const settings = useSettingsStore();
  const turns = shallowRef<ChatTurn[]>([]);
  const activeTurnId = shallowRef<string | null>(null);
  /** Set once a `/api/chat` request is rejected because the Access session has lapsed. */
  const sessionExpired = shallowRef(false);
  /**
   * The most recent streamed delta only (never the accumulated text), for a polite live region
   * to announce without re-reading the whole transcript on every token (see docs/05-AI-CHAT.md,
   * Phase 4, task 19's accessibility requirements).
   */
  const lastDelta = shallowRef("");

  const isStreaming = computed(() => activeTurnId.value !== null);

  let abortController: AbortController | null = null;

  /** Replace one turn in {@link turns} with a shallow-merged patch, preserving array identity. */
  function patchTurn(id: string, patch: Partial<ChatTurn>): void {
    turns.value = turns.value.map((turn) =>
      turn.id === id ? { ...turn, ...patch } : turn,
    );
  }

  /** Apply one decoded stream frame to the turn it belongs to. */
  function applyFrame(id: string, frame: ChatStreamFrame): void {
    switch (frame.type) {
      case "start":
        return;
      case "thinking":
        lastDelta.value = frame.text;
        turns.value = turns.value.map((turn) =>
          turn.id === id
            ? { ...turn, thinking: turn.thinking + frame.text }
            : turn,
        );
        return;
      case "answer":
        lastDelta.value = frame.text;
        turns.value = turns.value.map((turn) =>
          turn.id === id ? { ...turn, answer: turn.answer + frame.text } : turn,
        );
        return;
      case "done":
        patchTurn(id, {
          status: "done",
          ttftMs: frame.ttftMs,
          totalMs: frame.totalMs,
          usage: frame.usage,
          finishReason: frame.finishReason,
        });
        return;
      case "error":
        patchTurn(id, { status: "error", errorDetail: frame.detail });
        return;
    }
  }

  /**
   * Submit one new user turn: appends it to {@link turns} immediately, sends the full
   * conversation so far to `POST /api/chat`, and streams the response into that turn's `answer`/
   * `thinking` fields as frames arrive. Never issues a second request while one is in flight.
   *
   * @param content Raw composer text; trimmed, and ignored if empty or a turn is already
   * streaming.
   */
  async function submit(content: string): Promise<void> {
    const trimmed = content.trim();
    if (trimmed.length === 0 || isStreaming.value) {
      return;
    }

    const descriptor = settings.descriptor;
    const id = crypto.randomUUID();
    const messages = buildConversation(turns.value, trimmed);
    const turn: ChatTurn = {
      id,
      modelId: descriptor.id,
      modelDisplayName: descriptor.displayName,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      userContent: trimmed,
      answer: "",
      thinking: "",
      status: "streaming",
      ttftMs: null,
      totalMs: null,
      usage: null,
      finishReason: null,
      errorDetail: null,
    };

    turns.value = [...turns.value, turn];
    activeTurnId.value = id;
    sessionExpired.value = false;
    lastDelta.value = "";

    const startedAt = Date.now();
    abortController = new AbortController();

    const body: ChatRequestBody = {
      model: descriptor.id,
      messages,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    };

    try {
      const response = await fetch("/api/chat", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: abortController.signal,
      });

      for await (const frame of readChatStream(response)) {
        applyFrame(id, frame);
      }
    } catch (cause) {
      if (isAbortError(cause)) {
        patchTurn(id, {
          status: "stopped",
          finishReason: "cancelled",
          totalMs: Date.now() - startedAt,
        });
      } else if (cause instanceof ChatResponseError) {
        if (cause.sessionExpired) {
          sessionExpired.value = true;
        }
        patchTurn(id, {
          status: "error",
          errorDetail: cause.sessionExpired
            ? "Your session expired. Sign in again to continue."
            : cause.message,
          totalMs: Date.now() - startedAt,
        });
      } else {
        patchTurn(id, {
          status: "error",
          errorDetail:
            cause instanceof Error ? cause.message : "The request failed.",
          totalMs: Date.now() - startedAt,
        });
      }
    } finally {
      abortController = null;
      activeTurnId.value = null;
    }
  }

  /**
   * Cancel the in-flight turn, if any. Aborting the `fetch()` signal drops the underlying
   * connection while the response body is still being read, which the Worker observes as its
   * outgoing stream being cancelled — see `src/worker/chat/stream.ts`'s `cancel()` handler,
   * which aborts `env.AI.run()` in turn so a stopped generation stops billing.
   */
  function stop(): void {
    abortController?.abort();
  }

  return {
    isStreaming,
    lastDelta,
    sessionExpired,
    stop,
    submit,
    turns,
  };
});
