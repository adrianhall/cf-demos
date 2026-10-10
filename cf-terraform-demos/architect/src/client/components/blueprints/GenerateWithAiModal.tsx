import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionFrame } from '../../../live-sync-protocol.ts';
import { createDiagram, diagramLiveUrl, saveDiagramGraph } from '../../api/diagrams.ts';
import { useModalFocus } from '../../hooks/useModalFocus.ts';
import { computeAutoLayout } from '../../lib/auto-layout.ts';
import { applyClientOperation, type ParsedGraph, parseGraphData } from '../../lib/client-graph.ts';
import { describeOperation } from '../../lib/describe-operation.ts';
import type { ClientGraph } from '../../lib/graph-operation-diff.ts';
import { nextTranscriptEntryId } from '../editor/chat-transcript.ts';
import { AiChatPanel } from '../editor/panels/AiChatPanel.tsx';
import { useChatConversation } from '../editor/use-chat-conversation.ts';

/**
 * Accessible name and heading for this modal.
 */
const HEADING = 'Generate with AI';

/**
 * An empty graph, used before the first snapshot arrives.
 */
const EMPTY_GRAPH: ClientGraph = { edges: [], nodes: [] };

/**
 * Viewport a generated diagram is laid out against. The modal shows no canvas, so there is no
 * visitor-chosen pan or zoom to preserve; the editor fits the view on load anyway.
 */
const DEFAULT_VIEWPORT: ParsedGraph['viewport'] = { x: 0, y: 0, zoom: 1 };

/**
 * Wraps the operator's description in the instruction the model actually receives.
 *
 * The three additions are each there because the model does not reliably do them unprompted:
 * confining itself to product types this catalogue knows, giving the diagram a name, and saying why
 * it chose what it chose. None of this is shown to the operator — they see the sentence they typed,
 * passed separately as the transcript's display text — because echoing scaffolding back as
 * somebody's own words reads as machine noise.
 *
 * @param description The operator's own description, already trimmed.
 * @returns The literal text of the `chat_message` to send.
 */
function buildGenerationPrompt(description: string): string {
  return (
    `The user wants: ${description}. Propose an initial Cloudflare architecture using only the `
    + 'available product types, with sensible connections between them. Call rename_diagram with '
    + 'a short, descriptive title. Briefly explain your choices when you are done.'
  );
}

/**
 * Props for {@link GenerateWithAiModal}.
 */
export interface GenerateWithAiModalProps {
  /**
   * Called when the modal is dismissed. Shared by Cancel, Close, the close control, the backdrop
   * and Escape, so there is one close path rather than five.
   */
  onClose: () => void;
}

/**
 * Turns a sentence into a started diagram, without leaving the blueprint gallery.
 *
 * A second modal rather than a mode of {@link CreateDiagramModal}, because the two flows have
 * almost nothing in common beyond ending on the same page: that one is "fill in a form, create,
 * navigate", and this one is "describe something, watch it get built, then navigate". There are no
 * title or description fields here at all — the conversation names the diagram itself.
 *
 * **Nothing about this is a bespoke generation endpoint.** On submit it creates an ordinary blank
 * diagram through the route the blank-canvas card already uses, opens its own short-lived socket to
 * that diagram's `/api/diagrams/:id/live`, and sends one synthesized `chat_message`. Same route,
 * same owner-or-collaborator check, same `DiagramSession` instance, and the same frames the editor
 * handles — just from a far lighter component than the canvas. The transcript is the editor's own
 * `AiChatPanel`, driven by the editor's own `useChatConversation`, so a fix to either reaches
 * both.
 *
 * **Every change is already durable the moment it happens.** Each tool call the turn makes is
 * persisted and broadcast by the session before this modal ever hears about it, so there is nothing
 * staged here and nothing to save on the way out. Follow-up refinement turns run on the same open
 * connection, and the diagram is correct between each of them.
 *
 * That is also why **Open in Editor performs no whole-graph write of its own**, beyond the one
 * explicit layout pass. Writing this component's view of the graph back over the persisted one is
 * exactly the defect that lost a generated diagram's edges in the original: a client that had
 * diverged by one frame would silently overwrite the correct stored graph with its own stale copy.
 * The layout pass is the single deliberate exception — it changes positions, which no operation
 * expresses — and it is skipped entirely when the conversation added no nodes.
 *
 * **Dismissing the modal after at least one turn deliberately leaves the diagram behind**, holding
 * whatever was built, exactly as if it had been created blank, edited by hand and never reopened.
 * It appears on the dashboard and can be opened, renamed or deleted like any other. Creation is not
 * transactional with the conversation, and making it so would mean either deleting work somebody
 * may have wanted or holding a diagram unsaved in a browser tab — the thing the session design
 * exists to avoid. Dismissing before pressing Generate created nothing at all.
 *
 * Unlike {@link CreateDiagramModal}, this component is **mounted only while it is open** — the
 * gallery renders it conditionally rather than passing it an `open` prop. A dialog that holds a
 * socket, a conversation and a tracked graph has real state to discard, and unmounting discards all
 * of it in one place: the connection closes through the effect's own teardown, and reopening the
 * modal starts genuinely fresh rather than showing a previous conversation's transcript.
 *
 * @param props The close handler; see {@link GenerateWithAiModalProps}.
 * @returns The modal.
 */
export function GenerateWithAiModal({ onClose }: GenerateWithAiModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialogRef, onClose);

  const [description, setDescription] = useState('');
  const [diagramId, setDiagramId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [turnCompleted, setTurnCompleted] = useState(false);

  /**
   * The live connection, or `null` before it opens and after it closes.
   */
  const socketRef = useRef<WebSocket | null>(null);

  /**
   * The description captured at submit time.
   *
   * Read when the socket opens rather than when Generate was pressed, so it has to survive the gap.
   * A ref rather than state because a later keystroke in the (by then hidden) textarea must not
   * change a prompt that is already on its way.
   */
  const promptRef = useRef('');

  /**
   * Guards the auto-send effect so the opening message is sent exactly once per connection, rather
   * than on every render for as long as `connected` stays true.
   */
  const promptSentRef = useRef(false);

  /**
   * The graph as the session has confirmed it, rebuilt operation by operation.
   *
   * This modal shows no canvas, so this exists for one purpose: the layout pass needs the nodes and
   * edges, and asking the server for them again would introduce a second source of truth for a
   * value every broadcast already carries.
   */
  const graphRef = useRef<ClientGraph>(EMPTY_GRAPH);

  /**
   * Whether the conversation has added a node, which is what decides whether a layout pass is owed.
   * A removal does not qualify: removing a node cannot make the remaining arrangement worse.
   */
  const addedNodeRef = useRef(false);

  const chat = useChatConversation({
    onTurnEnded: () => setTurnCompleted(true)
  });
  const { appendInterruptingEntry, applyChatFrame } = chat;

  // The conversation's own connection. Opened once a diagram exists to talk about, and closed when
  // this component unmounts — which, because the gallery mounts it only while it is open, is
  // exactly when the operator dismisses it. Nothing resets state here: a diagram id is assigned
  // once per mount and never changes, so there is no second run of this effect to clean up after.
  useEffect(() => {
    if (diagramId === null) {
      return undefined;
    }

    const socket = new WebSocket(diagramLiveUrl(diagramId));
    socketRef.current = socket;

    /**
     * Records that the connection is usable, which releases the opening message.
     *
     * @returns Nothing.
     */
    const onOpen = (): void => setConnected(true);

    /**
     * Records that the connection is gone. The composer's own send already refuses a closed socket,
     * so there is nothing to tear down beyond the flag the "Connecting…" notice reads.
     *
     * @returns Nothing.
     */
    const onUnavailable = (): void => setConnected(false);

    /**
     * Applies one frame.
     *
     * Only three kinds matter here. Chat frames drive the transcript; an `ai-chat` operation is
     * both narrated and applied to the tracked graph; and a snapshot replaces that graph wholesale.
     * Everything else — presence, cursors, another editor's operation — belongs to a canvas this
     * modal does not have, and is ignored rather than handled, which is why this is a sequence of
     * guards rather than an exhaustive `switch`.
     *
     * @param event Message event carrying one JSON-encoded frame.
     * @returns Nothing.
     */
    const onMessage = (event: MessageEvent): void => {
      let frame: SessionFrame;
      try {
        frame = JSON.parse(String(event.data)) as SessionFrame;
      } catch {
        // Nothing here can act on a frame it cannot read, and nothing of the operator's has
        // failed: the diagram is whatever the session has already persisted.
        return;
      }

      switch (frame.type) {
        case 'chat_status':
        case 'chat_token':
        case 'chat_tool_result':
        case 'chat_done':
        case 'chat_error':
          applyChatFrame(frame);
          return;
        case 'snapshot':
          graphRef.current = parseGraphData(frame.graphData);
          return;
        case 'operation_applied': {
          if (frame.origin === 'ai-chat') {
            // Narrated from the **confirmed** broadcast, and described against the graph as it
            // stood before the change: a removal's target is gone the instant the operation is
            // applied below, and nothing else can recover its label.
            appendInterruptingEntry({
              id: nextTranscriptEntryId(),
              kind: 'action',
              text: describeOperation(
                frame.operation,
                graphRef.current.nodes,
                graphRef.current.edges
              )
            });
            if (frame.operation.kind === 'add_node') {
              addedNodeRef.current = true;
            }
          }
          try {
            graphRef.current = applyClientOperation(
              graphRef.current,
              frame.operation,
              DEFAULT_VIEWPORT
            );
          } catch {
            // This copy has diverged from the session's. It is only ever read to lay the diagram
            // out, so the cost of being wrong is a tidy-up against a stale graph — which would
            // then be written back. Forgetting it instead is the safe failure: with no nodes, the
            // layout pass is skipped and the persisted graph is left exactly as the session has it.
            graphRef.current = EMPTY_GRAPH;
            addedNodeRef.current = false;
          }
          return;
        }
        default:
          return;
      }
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('close', onUnavailable);
    socket.addEventListener('error', onUnavailable);
    socket.addEventListener('message', onMessage);

    return () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('close', onUnavailable);
      socket.removeEventListener('error', onUnavailable);
      socket.removeEventListener('message', onMessage);
      socketRef.current = null;
      setConnected(false);
      // Closed unconditionally, including mid-handshake: a socket abandoned while connecting
      // would otherwise finish opening after the modal has gone and stay open until the tab does.
      socket.close();
    };
  }, [diagramId, appendInterruptingEntry, applyChatFrame]);

  // The opening message, sent the instant the connection is usable rather than when Generate was
  // pressed. Sending before the socket is open would silently drop the one message this whole flow
  // exists to send, and there is no retry affordance here to recover from that.
  useEffect(() => {
    if (!connected || promptSentRef.current) {
      return;
    }
    promptSentRef.current = true;
    chat.sendChatMessage(
      socketRef.current,
      buildGenerationPrompt(promptRef.current),
      promptRef.current
    );
  }, [connected, chat]);

  /**
   * Creates the diagram the conversation will build into.
   *
   * @returns A promise fulfilled once the diagram exists, or once the failure has been reported.
   */
  const handleGenerate = useCallback(async (): Promise<void> => {
    const trimmed = description.trim();
    setCreating(true);
    setCreateError(null);
    try {
      const diagram = await createDiagram({});
      promptRef.current = trimmed;
      setDiagramId(diagram.id);
    } catch (cause) {
      // Reported rather than swallowed, and the compose view is kept: a failure here is usually
      // recoverable — an expired Access session above all — and losing what they typed would make
      // retrying cost more than it should.
      setCreateError(cause instanceof Error ? cause.message : 'Could not create the diagram.');
    } finally {
      setCreating(false);
    }
  }, [description]);

  /**
   * Sends one refinement message on the connection already open.
   *
   * @param text The operator's message.
   * @returns Whether the frame reached the socket.
   */
  const handleSend = useCallback(
    (text: string): boolean => chat.sendChatMessage(socketRef.current, text),
    [chat]
  );

  /**
   * Tidies the generated diagram's layout, then opens it in the full editor.
   *
   * The ELK pass runs only when the conversation added a node — an all-explanation turn has nothing
   * to reposition — and its result is persisted through the existing whole-graph route, which is
   * the only write this path performs. Everything the conversation built is already stored.
   *
   * @returns A promise fulfilled once the browser has been sent to the editor, or once the failure
   *   has been reported.
   * @throws Nothing. A failed layout or save is shown in the modal, and the diagram is left exactly
   *   as the conversation persisted it.
   */
  const handleOpenInEditor = useCallback(async (): Promise<void> => {
    // Not reachable through the rendered UI — the control only exists once a diagram does — but
    // this is also what narrows the id for the save below, so it is a guard rather than a cast.
    if (diagramId === null) {
      return;
    }

    setOpening(true);
    setOpenError(null);
    try {
      const { edges, nodes } = graphRef.current;
      if (addedNodeRef.current && nodes.length > 0) {
        const result = await computeAutoLayout(nodes, edges, 'DOWN');
        if (result !== null) {
          await saveDiagramGraph(
            diagramId,
            JSON.stringify({
              edges: result.edges,
              nodes: result.nodes,
              viewport: DEFAULT_VIEWPORT
            })
          );
        }
      }
      // A full document navigation, not a history push. `/app/*` requires a verified Access
      // identity, and only a real document request lets Access intercept it before the bundle for
      // that page runs — see `../../App.tsx`. It is also what tears this component, and its socket,
      // down.
      window.location.href = `/app/diagram/${diagramId}`;
    } catch (cause) {
      setOpening(false);
      setOpenError(
        cause instanceof Error ? cause.message : 'Could not open the diagram in the editor.'
      );
    }
  }, [diagramId]);

  const composing = diagramId === null;

  return (
    <div className="modal-overlay">
      {/* See `./CreateDiagramModal.tsx`'s identical control for why this is a real button with
          `tabIndex={-1}` rather than a click handler on a non-interactive element. */}
      <button
        type="button"
        className="modal-overlay__backdrop"
        aria-label="Close dialog"
        onClick={onClose}
        tabIndex={-1}
      />
      {/* A `div` with `role="dialog"` rather than a native `<dialog>`, for the reason
          `./CreateDiagramModal.tsx` sets out at length: every modal here shares one focus
          implementation, and `showModal()` does not compose with it. */}
      <div
        ref={dialogRef}
        className="modal modal--large generate-with-ai-modal"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="dialog"
        aria-modal="true"
        aria-label={HEADING}
        tabIndex={-1}
      >
        <button className="modal__close" onClick={onClose} aria-label="Close" type="button">
          &times;
        </button>
        <h2 className="modal__title">{HEADING}</h2>

        {composing ? (
          <div className="generate-with-ai-modal__compose">
            <label className="properties-panel__label" htmlFor="generate-with-ai-description">
              Describe the architecture you want to build
            </label>
            <textarea
              id="generate-with-ai-description"
              className="properties-panel__input properties-panel__textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              maxLength={2_000}
              placeholder="e.g. the backend for a real-time strategy game — matchmaking, live game state and a leaderboard."
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
                {creating ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </div>
        ) : (
          <div className="generate-with-ai-modal__chat">
            {!connected && <p className="generate-with-ai-modal__connecting">Connecting…</p>}
            <div className="generate-with-ai-modal__transcript">
              <AiChatPanel
                transcript={chat.transcript}
                inFlight={chat.inFlight}
                onSend={handleSend}
                onStop={chat.stopChatTurn}
                onNewConversation={chat.clearTranscript}
              />
            </div>

            {openError && (
              <p className="create-diagram-modal__error" role="alert">
                {openError}
              </p>
            )}

            <div className="create-diagram-modal__actions">
              {/* "Close" rather than "Cancel": by this point a diagram exists and keeps whatever
                  the conversation has already built, so offering to cancel would promise a
                  rollback that deliberately does not happen. */}
              <button type="button" className="button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void handleOpenInEditor()}
                disabled={opening || !turnCompleted}
              >
                {opening ? 'Opening…' : 'Open in Editor'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
