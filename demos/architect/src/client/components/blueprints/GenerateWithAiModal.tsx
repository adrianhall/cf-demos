import { useCallback, useEffect, useRef, useState } from "react";
import { createDiagram, saveDiagramGraph } from "../../api/diagrams";
import { useDiagramLiveSync } from "../../hooks/useDiagramLiveSync";
import { useModalFocus } from "../../hooks/useModalFocus";
import { computeAutoLayout } from "../../lib/auto-layout";
import { useDiagramStore } from "../../stores/diagramStore";
import { AiChatPanel } from "../editor/panels/AiChatPanel";

/**
 * Build the synthesized first `chat_message` for a generation conversation, exactly per
 * docs/09D-ARCHITECT-AICHAT.md's "Diagram Generation From A Description" step 3 -- the model is
 * given the operator's own description plus an explicit nudge to call `rename_diagram` and
 * explain its choices, so a generation turn behaves predictably even though the operator typed
 * no more than a one-line prompt.
 *
 * @param description The operator's own free-text description from the textarea.
 * @returns The literal `chat_message` text to send.
 */
function buildGenerationPrompt(description: string): string {
  return (
    `The user wants: ${description}. Propose an initial Cloudflare architecture using ` +
    "only the available product types, with sensible connections between them. Call " +
    "rename_diagram with a short, descriptive title. Briefly explain your choices when " +
    "you are done."
  );
}

/**
 * Modal for generating an initial diagram from a plain-language description
 * (docs/09D-ARCHITECT-AICHAT.md's "Diagram Generation From A Description"), opened by
 * `./BlueprintGallery.tsx`'s new "Generate with AI" tile alongside `./CreateDiagramModal.tsx`'s
 * existing blank/blueprint flow.
 *
 * This is deliberately a second, distinct modal rather than a variant of
 * `./CreateDiagramModal.tsx`: that modal's entire flow is "fill in a form, create, navigate",
 * while this one is "type a description, watch an AI conversation build the diagram, then
 * navigate" -- a textarea-then-transcript UI with no title/description form fields of its own.
 *
 * Generation is not a bespoke server endpoint. On submit, this component:
 *
 * 1. Calls the **existing** blank-diagram `createDiagram({})` to obtain a real `diagramId`
 *    (exactly `./CreateDiagramModal.tsx`'s own blank-canvas path), surfacing a failure the same
 *    way that modal does -- a visible error, not a silent one.
 * 2. Opens `../../hooks/useDiagramLiveSync.ts`'s own WebSocket to that diagram's
 *    `/api/diagrams/:id/live` -- the same route, owner check, and `DiagramSession` instance a
 *    full editor session would use, just from this lighter-weight component.
 * 3. Once the socket reports `connected` (not merely "attempted" -- sending before the socket is
 *    open would silently drop the very message this whole flow exists to send, and there is no
 *    separate retry path in this UI to recover from that), sends one `chat_message` built by
 *    {@link buildGenerationPrompt}.
 * 4. Switches from the textarea view to the transcript view, rendering the **same**
 *    `../editor/panels/AiChatPanel.tsx` the in-editor chat panel uses, fed directly by this
 *    component's own `useDiagramLiveSync()` call -- reused completely unchanged.
 *
 * The conversation does not have to stop there: `AiChatPanel`'s own composer already lets the
 * operator send further `chat_message`s on the same open connection before ever pressing "Open
 * in Editor", with no additional code needed here.
 *
 * "Open in Editor" runs the client-side auto-layout pass
 * (`../../lib/auto-layout.ts`'s `computeAutoLayout()`) only if the conversation actually added at
 * least one node -- an all-explanation turn that never touched the graph has nothing to
 * reposition, so this skips both the ELK call and the follow-up `PUT` entirely in that case, per
 * docs/09D-ARCHITECT-AICHAT.md's own "if any nodes were added" condition. When nodes did change,
 * the repositioned result is persisted via the **existing**
 * `saveDiagramGraph()`/`PUT /api/diagrams/:id/graph` route -- every other mutation the assistant
 * made is already durable via `DiagramSession`'s own write chain; only the layout pass's
 * repositioning needs this explicit save. Navigation is always a full page load
 * (`window.location.href`), matching every other `/app*` boundary crossing in this SPA
 * (`./CreateDiagramModal.tsx`'s own precedent) -- which is also what actually tears down this
 * component and, with it, its live-sync WebSocket.
 *
 * If the operator instead dismisses the modal (backdrop click, Escape, the close button) after
 * at least one turn has run, the diagram row created in step 1 is deliberately left behind with
 * whatever the assistant already built -- exactly as `./CreateDiagramModal.tsx` already does for
 * its own blank/blueprint path: no rollback, no delete-on-cancel call. Dismissing before ever
 * pressing "Generate" (still on the textarea view) never called `createDiagram()` at all, so
 * there is nothing left behind in that case. This component stays mounted across a close/reopen
 * cycle (returning `null` while `!open`, mirroring `./CreateDiagramModal.tsx`'s own pattern)
 * rather than actually unmounting on close, so `useDiagramLiveSync()`'s own `enabled` parameter
 * -- passed `open` directly, not just "has a diagram id" -- is what actually closes the
 * WebSocket the moment the modal is dismissed, and reopens a fresh one (with a fresh, empty
 * transcript; the hook resets its own per-connection state on every new connection) if the
 * operator reopens the same modal instance afterward.
 *
 * @param open Whether the modal is visible.
 * @param onClose Called when the modal is dismissed.
 */
export function GenerateWithAiModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onClose);

  const [description, setDescription] = useState("");
  const [diagramId, setDiagramId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [openingInEditor, setOpeningInEditor] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [hasCompletedFirstTurn, setHasCompletedFirstTurn] = useState(false);

  // The description text to send as the first `chat_message`, captured once at submit time so
  // a later edit to the (by-then-hidden) textarea state can never affect an already-sent prompt.
  const descriptionToSendRef = useRef("");
  // Guards the auto-send effect below so it fires exactly once per diagram, the instant the
  // socket first reports `connected` -- never on every render once connected stays `true`.
  const autoSentRef = useRef(false);
  // Tracks `chatInFlight`'s previous value so the effect below can detect the transition from
  // "a turn is running" to "a turn just finished," regardless of which turn (first or a later
  // follow-up) that transition belongs to.
  const wasInFlightRef = useRef(false);

  // `enabled` is `open` itself, not merely "a diagram id exists": this component stays mounted
  // across a close/reopen cycle (see this component's own top-of-file JSDoc), so tying `enabled`
  // to `open` is what makes closing the modal actually close the socket, and reopening it
  // actually reconnect -- `../../hooks/useDiagramLiveSync.ts`'s own effect closes/reopens on
  // every change to either of its two inputs.
  const {
    connected,
    chatTranscript,
    chatInFlight,
    sendChatMessage,
    stopChatTurn,
    clearChatTranscript,
  } = useDiagramLiveSync(diagramId, open);

  useEffect(() => {
    if (diagramId === null || !connected || autoSentRef.current) return;
    autoSentRef.current = true;
    // The model gets the full synthesized instruction; the transcript shows only what the user
    // actually typed, rather than echoing the scaffolding back at them.
    sendChatMessage(
      buildGenerationPrompt(descriptionToSendRef.current),
      descriptionToSendRef.current,
    );
  }, [diagramId, connected, sendChatMessage]);

  useEffect(() => {
    if (wasInFlightRef.current && !chatInFlight) {
      setHasCompletedFirstTurn(true);
    }
    wasInFlightRef.current = chatInFlight;
  }, [chatInFlight]);

  const handleGenerate = useCallback(async () => {
    const trimmed = description.trim();
    // Defense in depth: the Generate button below is already `disabled` whenever the trimmed
    // description is empty, and a disabled native `<button>` never dispatches a `click` event at
    // all (by the HTML spec), so this is unreachable through the rendered UI -- kept in case a
    // future caller ever invokes `handleGenerate` some other way.
    /* istanbul ignore next */
    if (trimmed.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      const diagram = await createDiagram({});
      descriptionToSendRef.current = trimmed;
      setDiagramId(diagram.id);
    } catch (cause) {
      setCreateError(
        cause instanceof Error
          ? cause.message
          : "Could not create the diagram.",
      );
    } finally {
      setCreating(false);
    }
  }, [description]);

  /**
   * Run the client-side auto-layout pass (only if the conversation added at least one node),
   * persist its result via the existing `PUT /api/diagrams/:id/graph` route, then navigate into
   * the full editor -- see this component's own top-of-file JSDoc for why each step is scoped
   * exactly this way.
   */
  const handleOpenInEditor = useCallback(async () => {
    // Defense in depth: the "Open in Editor" button is only ever rendered once `diagramId` is
    // set (the chat phase, gated by `phase === "chat"` below), so this is unreachable through
    // the rendered UI -- kept in case a future caller ever invokes `handleOpenInEditor` some
    // other way.
    /* istanbul ignore next */
    if (diagramId === null) return;
    setOpeningInEditor(true);
    setOpenError(null);
    try {
      const { nodes, edges, viewport } = useDiagramStore.getState();
      if (nodes.length > 0) {
        const result = await computeAutoLayout(nodes, edges, "DOWN");
        if (result !== null) {
          await saveDiagramGraph(
            diagramId,
            JSON.stringify({
              edges: result.edges,
              nodes: result.nodes,
              viewport,
            }),
          );
        }
      }
      window.location.href = `/app/diagram/${diagramId}`;
    } catch (cause) {
      setOpeningInEditor(false);
      setOpenError(
        cause instanceof Error
          ? cause.message
          : "Could not open the diagram in the editor.",
      );
    }
  }, [diagramId]);

  if (!open) return null;

  const phase: "compose" | "chat" = diagramId === null ? "compose" : "chat";

  return (
    <div className="modal-overlay">
      {/* See `./CreateDiagramModal.tsx`'s identical button for why this is a real,
          keyboard-inert button rather than a click handler on a non-interactive `<div>`. */}
      <button
        type="button"
        className="modal-overlay__backdrop"
        aria-label="Close dialog"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="modal modal--large generate-with-ai-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Generate with AI"
        tabIndex={-1}
      >
        <button
          className="modal__close"
          onClick={onClose}
          aria-label="Close"
          type="button"
        >
          &times;
        </button>
        <h2 className="modal__title">Generate with AI</h2>

        {phase === "compose" ? (
          <div className="generate-with-ai-modal__compose">
            <label
              className="properties-panel__label"
              htmlFor="generate-with-ai-description"
            >
              Describe the architecture you want to build
            </label>
            <textarea
              id="generate-with-ai-description"
              className="properties-panel__input properties-panel__textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              maxLength={2_000}
              placeholder="e.g. I want to build the backend for a real-time strategy game -- matchmaking, live game state, and a leaderboard."
            />

            {createError && (
              <p className="create-diagram-modal__error" role="alert">
                {createError}
              </p>
            )}

            <div className="create-diagram-modal__actions">
              <button type="button" className="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void handleGenerate()}
                disabled={creating || description.trim().length === 0}
              >
                {creating ? "Generating…" : "Generate"}
              </button>
            </div>
          </div>
        ) : (
          <div className="generate-with-ai-modal__chat">
            {!connected && (
              <p className="generate-with-ai-modal__connecting">Connecting…</p>
            )}
            <div className="generate-with-ai-modal__transcript">
              <AiChatPanel
                transcript={chatTranscript}
                inFlight={chatInFlight}
                onSend={sendChatMessage}
                onStop={stopChatTurn}
                onNewConversation={clearChatTranscript}
              />
            </div>

            {openError && (
              <p className="create-diagram-modal__error" role="alert">
                {openError}
              </p>
            )}

            <div className="create-diagram-modal__actions">
              <button type="button" className="button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void handleOpenInEditor()}
                disabled={openingInEditor || !hasCompletedFirstTurn}
              >
                {openingInEditor ? "Opening…" : "Open in Editor"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
