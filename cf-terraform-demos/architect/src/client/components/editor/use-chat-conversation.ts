import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientFrame, SessionFrame } from '../../../live-sync-protocol.ts';
import { type ChatTranscriptEntry, nextTranscriptEntryId } from './chat-transcript.ts';

/**
 * @file One assistant conversation, as a hook: the transcript, whether a turn is in flight, and the
 *   frame handling that keeps the two in step. It exists because there are now **two** places that
 *   hold a live socket and watch a chat turn travel over it — the editor canvas
 *   (`./DiagramCanvas.tsx`) and the blueprint page's generation modal
 *   (`../blueprints/GenerateWithAiModal.tsx`) — and every rule below was learned the hard way once.
 *   Writing it twice would mean the second copy drifting from the first the next time one of them
 *   is fixed. What this hook deliberately does **not** own is the graph. The canvas reconciles
 *   operations against its optimistic document and the modal simply tracks what the conversation
 *   has built; those are genuinely different jobs, and folding them in here would produce a hook
 *   with two modes. The split is: this owns the conversation, the caller owns the diagram.
 */

/**
 * Every frame this hook knows how to apply.
 *
 * Narrowed from {@link SessionFrame} rather than listed, so a chat frame added to the protocol is a
 * build failure here until it is handled — which is the same property the callers' own exhaustive
 * `switch` statements rely on.
 */
export type ChatFrame = Extract<
  SessionFrame,
  { type: 'chat_status' | 'chat_token' | 'chat_tool_result' | 'chat_done' | 'chat_error' }
>;

/**
 * Options for {@link useChatConversation}.
 */
export interface UseChatConversationOptions {
  /**
   * Called once each time a turn **this** tab started reaches its outcome, whether it succeeded or
   * failed, and only for a turn that was not stopped.
   *
   * It is the seam each caller uses for the thing it owes a finished turn: the canvas lays the
   * diagram out, and the modal enables its Open in Editor control. Required rather than optional,
   * because a caller with nothing to do at the end of a turn would have no reason to be watching
   * one. Held in a ref internally, so a caller may pass an inline closure without making every
   * returned callback unstable.
   *
   * @returns Nothing.
   */
  onTurnEnded: () => void;
}

/**
 * One conversation's state and the operations on it.
 */
export interface ChatConversation {
  /**
   * Every entry accumulated so far, in arrival order. The whole of what `./panels/AiChatPanel.tsx`
   * renders.
   */
  transcript: ChatTranscriptEntry[];
  /**
   * Whether a turn this tab started is awaiting its own `chat_done` or `chat_error`.
   */
  inFlight: boolean;
  /**
   * Whether a turn is in flight, read synchronously rather than from the rendered state.
   *
   * The canvas needs this inside a frame handler, where the `inFlight` value captured by the
   * current render may already be stale: an `ai-chat` operation broadcast arriving in the same
   * batch as the frame that started the turn must see the turn as in flight, or it announces the
   * visitor's own request back to them as somebody else's edit.
   *
   * @returns Whether this tab currently has a turn awaiting its outcome.
   */
  hasTurnInFlight: () => boolean;
  /**
   * Appends a non-assistant entry, closing out any assistant bubble being streamed to.
   *
   * Closing the bubble is what keeps the transcript chronological, and it is the whole reason this
   * is exposed rather than kept private: the canvas appends its own `action` entries from confirmed
   * operation broadcasts, which are not chat frames at all, and they have to interrupt the stream
   * exactly as a status frame does. A turn narrates, calls tools, then narrates again; every entry
   * is a plain end-append, so a bubble left anchored where its first token landed would go on
   * collecting that later prose and put the turn's closing summary _above_ the tool activity it
   * followed. Clearing the anchor makes the next token open a fresh bubble beneath this entry.
   *
   * @param entry The status, action, docs or error entry to append.
   * @returns Nothing.
   */
  appendInterruptingEntry: (entry: ChatTranscriptEntry) => void;
  /**
   * Applies one chat frame to the transcript.
   *
   * @param frame The frame to apply; see {@link ChatFrame}.
   * @returns Nothing.
   */
  applyChatFrame: (frame: ChatFrame) => void;
  /**
   * Sends one message and starts a turn.
   *
   * @param socket Connection to send on, or `null` when there is none. A socket that is not open is
   *   treated the same way: nothing is sent and nothing is recorded.
   * @param text The message the model receives.
   * @param displayText What the transcript shows instead, when the two differ. The generation modal
   *   wraps a one-line description in a much longer instruction, and echoing that scaffolding back
   *   as the visitor's own words reads as machine noise. Defaults to `text`.
   * @returns Whether the frame reached the socket. `false` leaves the caller's draft in place, so a
   *   message typed while the connection was dropping is not lost.
   */
  sendChatMessage: (socket: WebSocket | null, text: string, displayText?: string) => boolean;
  /**
   * Stops rendering the in-flight turn's remaining answer.
   *
   * Client-side only. There is no cancellation frame in the protocol: the turn is running inside
   * the Durable Object, which deliberately completes a turn whose originator has disconnected
   * entirely, so there is nothing a tab could send that would interrupt it. Every mutation the turn
   * still makes arrives as an ordinary broadcast; only this tab's narration of the rest is
   * suppressed, and the resulting bubble's wording says exactly that.
   *
   * @returns Nothing. A no-op when no turn is in flight.
   */
  stopChatTurn: () => void;
  /**
   * Clears the transcript without touching the connection.
   *
   * Local only. The session's own per-connection history is not reset, because no frame in this
   * protocol asks it to — every frame either starts a turn or reports one's outcome — and closing
   * and reopening the socket to achieve it would also discard presence and every operation still in
   * flight. The resulting gap is small and deliberate: the reader gets a clean panel, and the model
   * remembers a conversation that is no longer on screen until the connection ends.
   *
   * @returns Nothing.
   */
  clearTranscript: () => void;
  /**
   * Resets the conversation completely, for a new connection or a new diagram.
   *
   * Stronger than {@link ChatConversation.clearTranscript}: it also drops the in-flight turn and
   * every bookkeeping ref, because a turn belongs to the connection it ran on and nothing from a
   * previous one may be waited on afterwards.
   *
   * @returns Nothing.
   */
  resetConversation: () => void;
}

/**
 * Holds one assistant conversation for as long as its caller is mounted.
 *
 * @param options The turn-completion callback; see {@link UseChatConversationOptions}.
 * @returns The transcript, the in-flight flag and the operations on them; see
 *   {@link ChatConversation}.
 */
export function useChatConversation(options: UseChatConversationOptions): ChatConversation {
  const [transcript, setTranscript] = useState<ChatTranscriptEntry[]>([]);
  const [inFlight, setInFlight] = useState(false);

  // Held in a ref so a caller can pass an inline closure. Reading it through the ref is what keeps
  // every callback below stable, which matters because the canvas's socket effect lists them as
  // dependencies — an unstable one would tear the connection down and rebuild it on each render.
  // Written in an effect rather than during render: a render that React discards must not leave
  // behind a callback that was never committed.
  const onTurnEndedRef = useRef(options.onTurnEnded);
  useEffect(() => {
    onTurnEndedRef.current = options.onTurnEnded;
  }, [options.onTurnEnded]);

  /**
   * The turn this tab is waiting on, or `null` when none is in flight.
   */
  const activeRequestIdRef = useRef<string | null>(null);

  /**
   * The assistant bubble tokens are currently appending to, or `null` when the next token should
   * open a fresh one. Cleared by every interrupting append; see
   * {@link ChatConversation.appendInterruptingEntry}.
   */
  const activeAssistantEntryIdRef = useRef<string | null>(null);

  /**
   * Whether the in-flight turn has streamed at least one token, which decides whether `chat_done`
   * has to record the answer itself.
   */
  const streamedAnyTokenRef = useRef(false);

  /**
   * Turns the visitor has stopped watching. Their remaining tokens are dropped and their eventual
   * `chat_done` or `chat_error` is consumed silently rather than appended a second time.
   */
  const stoppedRequestIdsRef = useRef(new Set<string>());

  const hasTurnInFlight = useCallback((): boolean => activeRequestIdRef.current !== null, []);

  const appendInterruptingEntry = useCallback((entry: ChatTranscriptEntry): void => {
    activeAssistantEntryIdRef.current = null;
    setTranscript((current) => [...current, entry]);
  }, []);

  /**
   * Ends the turn a terminal frame belongs to, if it is the one this tab is waiting on.
   *
   * @param clientRequestId Turn the frame reported on.
   * @returns Nothing.
   */
  const finishTurn = useCallback((clientRequestId: string): void => {
    if (activeRequestIdRef.current !== clientRequestId) {
      return;
    }
    activeRequestIdRef.current = null;
    activeAssistantEntryIdRef.current = null;
    streamedAnyTokenRef.current = false;
    setInFlight(false);
    onTurnEndedRef.current();
  }, []);

  const applyChatFrame = useCallback(
    (frame: ChatFrame): void => {
      switch (frame.type) {
        case 'chat_status':
          appendInterruptingEntry({
            id: nextTranscriptEntryId(),
            kind: 'status',
            text: frame.message
          });
          return;
        case 'chat_token': {
          if (stoppedRequestIdsRef.current.has(frame.clientRequestId)) {
            return;
          }
          // The entry id is resolved and both refs are written **here**, synchronously, never
          // inside the updater below. React defers an updater until render and may run it more
          // than once, so an updater that reads or writes a ref does not observe what its own
          // handler saw — which is how a token and the `chat_done` batched into the same render
          // used to produce two bubbles for one answer.
          const openBubbleId = activeAssistantEntryIdRef.current;
          const isNewBubble = openBubbleId === null;
          const entryId = openBubbleId ?? nextTranscriptEntryId();
          activeAssistantEntryIdRef.current = entryId;
          streamedAnyTokenRef.current = true;
          const { text } = frame;
          setTranscript((current) =>
            isNewBubble
              ? [...current, { id: entryId, kind: 'assistant', stopped: false, text }]
              : current.map((entry) =>
                  entry.id === entryId && entry.kind === 'assistant'
                    ? { ...entry, text: entry.text + text }
                    : entry
                )
          );
          return;
        }
        case 'chat_tool_result':
          appendInterruptingEntry({
            id: nextTranscriptEntryId(),
            kind: 'docs_result',
            outcome: frame.outcome,
            query: frame.query
          });
          return;
        case 'chat_done': {
          const wasStopped = stoppedRequestIdsRef.current.delete(frame.clientRequestId);
          // Read synchronously, before `finishTurn` resets it, for the reason the token arm
          // documents.
          const streamedAnyToken = streamedAnyTokenRef.current;
          if (!wasStopped && !streamedAnyToken) {
            // Nothing streamed — an empty answer, or a whole response that arrived unstreamed —
            // so there is no bubble showing it and this frame's copy is the only one there is.
            //
            // When tokens *did* stream there is deliberately nothing to do. `assistantText` is by
            // construction the concatenation of exactly those tokens, and a turn may own several
            // bubbles because tool activity splits them, so rewriting "the" bubble with the whole
            // answer would duplicate every earlier bubble's prose into the last one.
            const { assistantText } = frame;
            setTranscript((current) => [
              ...current,
              {
                id: nextTranscriptEntryId(),
                kind: 'assistant',
                stopped: false,
                text: assistantText
              }
            ]);
          }
          finishTurn(frame.clientRequestId);
          return;
        }
        case 'chat_error': {
          const wasStopped = stoppedRequestIdsRef.current.delete(frame.clientRequestId);
          if (!wasStopped) {
            appendInterruptingEntry({
              id: nextTranscriptEntryId(),
              kind: 'error',
              text: frame.message
            });
          }
          // A failed turn still ended, and whatever it had already applied stayed applied — each
          // operation was persisted and broadcast on its own — so the caller's end-of-turn work is
          // owed exactly as it would be after a success.
          finishTurn(frame.clientRequestId);
          return;
        }
      }
    },
    [appendInterruptingEntry, finishTurn]
  );

  const sendChatMessage = useCallback(
    (socket: WebSocket | null, text: string, displayText?: string): boolean => {
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        return false;
      }

      const clientRequestId = crypto.randomUUID();
      activeRequestIdRef.current = clientRequestId;
      activeAssistantEntryIdRef.current = null;
      streamedAnyTokenRef.current = false;
      setInFlight(true);
      // Appended here rather than waiting for the session to echo it, because the session never
      // does: the frame carries no author, exactly as an operation does not, and what the visitor
      // typed is already known locally.
      setTranscript((current) => [
        ...current,
        { id: nextTranscriptEntryId(), kind: 'user', text: displayText ?? text }
      ]);
      socket.send(
        JSON.stringify({ clientRequestId, text, type: 'chat_message' } satisfies ClientFrame)
      );
      return true;
    },
    []
  );

  const stopChatTurn = useCallback((): void => {
    const clientRequestId = activeRequestIdRef.current;
    if (clientRequestId === null) {
      return;
    }

    stoppedRequestIdsRef.current.add(clientRequestId);
    const bubbleId = activeAssistantEntryIdRef.current;
    if (bubbleId !== null) {
      setTranscript((current) =>
        current.map((entry) =>
          entry.id === bubbleId && entry.kind === 'assistant' ? { ...entry, stopped: true } : entry
        )
      );
    }

    // Deliberately not `finishTurn`: the caller's end-of-turn work is not owed for a turn the
    // visitor walked away from, and the turn's own terminal frame is still coming — it is consumed
    // silently by the stopped-id set above.
    activeRequestIdRef.current = null;
    activeAssistantEntryIdRef.current = null;
    streamedAnyTokenRef.current = false;
    setInFlight(false);
  }, []);

  const clearTranscript = useCallback((): void => {
    setTranscript([]);
    // An in-flight turn's next token opens a fresh bubble rather than trying to append to an id
    // the now-empty transcript no longer contains.
    activeAssistantEntryIdRef.current = null;
  }, []);

  const resetConversation = useCallback((): void => {
    setTranscript([]);
    setInFlight(false);
    activeRequestIdRef.current = null;
    activeAssistantEntryIdRef.current = null;
    streamedAnyTokenRef.current = false;
    stoppedRequestIdsRef.current.clear();
  }, []);

  return {
    appendInterruptingEntry,
    applyChatFrame,
    clearTranscript,
    hasTurnInFlight,
    inFlight,
    resetConversation,
    sendChatMessage,
    stopChatTurn,
    transcript
  };
}
