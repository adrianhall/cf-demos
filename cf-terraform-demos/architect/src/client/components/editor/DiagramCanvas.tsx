import { useCallback, useEffect, useRef, useState } from 'react';
import { valueOrDefault } from '@adrianhall/cloudflare-toolkit';
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  useNodesInitialized,
  useReactFlow
} from '@xyflow/react';
import { CATEGORY_COLORS, NODE_TYPE_MAP } from '../../../catalog.ts';
import { CF_EDGE_TYPE, CF_NODE_TYPE } from '../../../graph-element-types.ts';
import type {
  ChangeOrigin,
  ClientFrame,
  OperationAppliedFrame,
  PresenceParticipant,
  SessionFrame
} from '../../../live-sync-protocol.ts';
import { applyGraphOperation } from '../../../worker/domain/graph-operations.ts';
import {
  diagramLiveUrl,
  getAccessibleDiagram,
  saveDiagramGraph,
  updateDiagram
} from '../../api/diagrams.ts';
import type { SharedDiagram } from '../../api/shares.ts';
import {
  computeAutoLayout,
  LAYOUT_FIT_DELAY_MS,
  LAYOUT_FIT_DURATION_MS
} from '../../lib/auto-layout.ts';
import { describeOperation } from '../../lib/describe-operation.ts';
import { diffGraphOperations, type ClientGraph } from '../../lib/graph-operation-diff.ts';
import { useDiagramStore } from '../../stores/diagramStore.ts';
import { type ChatTranscriptEntry, nextTranscriptEntryId } from './chat-transcript.ts';
import { edgeTypes } from './edges/edgeTypes.ts';
import { nodeTypes } from './nodes/nodeTypes.ts';
import { DetailsPanel } from './panels/DetailsPanel.tsx';
import { ServicePalette } from './panels/ServicePalette.tsx';
import {
  RemoteCursorsOverlay,
  type RemoteCursor,
  type RemoteSelection
} from './RemoteCursorsOverlay.tsx';
import { StatusBar } from './toolbar/StatusBar.tsx';
import { Toolbar } from './toolbar/Toolbar.tsx';
import type { CFEdgeData, CFNodeData } from './types.ts';

/**
 * How long after the last change the graph is saved, in milliseconds.
 *
 * Short enough that a visitor who stops to think has already been saved, long enough that dragging
 * a node across the canvas is one save rather than fifty.
 */
const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * Maximum cursor frames this tab sends per second.
 *
 * Cursor frames are intentionally lossy and never queued; limiting them avoids making a fast
 * pointer movement compete with the durable operation path on a small connection.
 */
const CURSOR_THROTTLE_MS = 1_000 / 15;

/**
 * How long after the last keystroke the title is saved, in milliseconds.
 *
 * Longer than the graph's: a title is typed a character at a time, and each save is a whole request
 * for a field nobody is racing to persist.
 */
const TITLE_SAVE_DEBOUNCE_MS = 1_000;

/**
 * Grid, in pixels, that dragged nodes snap to. Alignment by construction rather than by eye.
 */
const SNAP_GRID: [number, number] = [16, 16];

/**
 * How long to wait after fitting the view before opening the print dialog, in milliseconds.
 *
 * `window.print()` snapshots the page synchronously, so it has to run after the browser has
 * actually painted the fitted viewport. One frame is not reliably enough — the fit animates the
 * transform — so this is a deliberate short wait rather than a `requestAnimationFrame`.
 */
const PRINT_DIALOG_DELAY_MS = 300;

/**
 * Class applied to `<body>` while the canvas is in print mode, which the stylesheet's print-only
 * rules key off.
 */
const PRINT_MODE_BODY_CLASS = 'diagram-editor-print-mode';

/**
 * Id of the `<style>` element carrying the chosen `@page` orientation, so it can be removed again
 * on the way out.
 */
const PRINT_ORIENTATION_STYLE_ID = 'diagram-editor-print-orientation';

/**
 * A diagram's graph, parsed.
 */
interface ParsedGraphData {
  /**
   * Nodes on the canvas.
   */
  nodes: Node<CFNodeData>[];
  /**
   * Edges on the canvas.
   */
  edges: Edge<CFEdgeData>[];
  /**
   * Stored pan and zoom.
   */
  viewport: { x: number; y: number; zoom: number };
}

/**
 * Parses a diagram's stored graph.
 *
 * Tolerant on purpose: an empty, truncated or unparseable value yields an empty canvas rather than
 * an exception. The alternative is an editor that refuses to open at all, which leaves the visitor
 * with no way to repair the diagram — whereas an empty canvas they can rebuild and save over is
 * recoverable.
 *
 * @param graphData Stored JSON string.
 * @returns The parsed graph, with every missing field defaulted.
 */
function parseGraphData(graphData: string): ParsedGraphData {
  try {
    const parsed = JSON.parse(graphData || '{}') as Partial<ParsedGraphData>;
    return {
      edges: parsed.edges ?? [],
      nodes: parsed.nodes ?? [],
      viewport: parsed.viewport ?? { x: 0, y: 0, zoom: 1 }
    };
  } catch {
    return { edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  }
}

/**
 * Applies one shared graph operation to a client graph.
 *
 * The server's own pure function is used rather than reimplemented; this helper only restores the
 * richer React Flow types it cannot know about. It is the building block for optimistic replay:
 * remote operations are applied to the confirmed graph, then pending local operations are replayed
 * over it in dispatch order.
 *
 * @param graph Graph to change.
 * @param operation Operation to apply.
 * @param viewport Current viewport, which operations never change but the shared graph shape needs.
 * @returns A new client graph.
 * @throws {ProblemDetailsError} When the operation cannot be applied to this graph, which means the
 *   client has diverged and must request a snapshot.
 */
function applyClientOperation(
  graph: ClientGraph,
  operation: OperationAppliedFrame['operation'],
  viewport: ParsedGraphData['viewport']
): ClientGraph {
  const next = applyGraphOperation({ edges: graph.edges, nodes: graph.nodes, viewport }, operation);
  return {
    edges: next.edges as Edge<CFEdgeData>[],
    nodes: next.nodes as Node<CFNodeData>[]
  };
}

/**
 * Replays pending optimistic operations over a confirmed graph.
 *
 * @param confirmed Graph the session has confirmed.
 * @param pending This tab's operations still waiting for echoes, in dispatch order.
 * @param viewport Current viewport, carried through unchanged.
 * @returns The optimistic graph the canvas should show.
 * @throws {ProblemDetailsError} When a pending operation no longer applies after a remote change —
 *   for example another editor removed its target first. The rejection/resync path resolves that
 *   conflict rather than presenting a graph the server will never store.
 */
function replayPendingOperations(
  confirmed: ClientGraph,
  pending: Iterable<OperationAppliedFrame['operation']>,
  viewport: ParsedGraphData['viewport']
): ClientGraph {
  let optimistic = confirmed;
  for (const operation of pending) {
    optimistic = applyClientOperation(optimistic, operation, viewport);
  }
  return optimistic;
}

/**
 * Props for {@link DiagramCanvas}.
 */
export interface DiagramCanvasProps {
  /**
   * Id of the diagram to load, taken from the path by the app shell.
   */
  diagramId: string;
  /**
   * Whether the canvas is read-only — the anonymous share viewer's posture.
   *
   * Every editing affordance is withheld rather than disabled, and every editing effect is skipped
   * rather than left to find nothing to do.
   */
  readOnly?: boolean;
  /**
   * The diagram's fields, already fetched by the public share resolver.
   *
   * Required when `readOnly` is set, and the reason the two props travel together: an anonymous
   * viewer has no Access identity and therefore cannot call the owner-authenticated read this
   * component otherwise makes. Passing the already-resolved diagram in is what lets one component
   * serve both postures instead of a near-duplicate being written for the viewer.
   */
  initialDiagram?: SharedDiagram;
}

/**
 * The architecture canvas: the editor's working surface, and the anonymous share viewer's.
 *
 * It loads the diagram, autosaves it, and wires every way of changing it — dragging a service in
 * from the palette, activating one from the keyboard, selecting, deleting, undoing and redoing — to
 * the store that keeps those changes in step with the save state.
 *
 * Every mutation goes through that store rather than through local state, which is what makes the
 * autosave below correct: it reads the graph at the moment the timer fires, so it always sends the
 * canvas as it actually stands rather than as it stood when the change that scheduled it happened.
 *
 * **Read-only mode** is one component rather than two because the difference is genuinely a set of
 * omissions: the same graph, the same renderers, the same geometry, with every editing effect
 * skipped and every editing control absent. A second component would be this file with its verbs
 * removed, and would drift from it the first time a node renderer changed. Each `readOnly` guard
 * below is written explicitly even where the effect would be inert anyway — `dirty` never becomes
 * true when nothing can change the graph — because an inert effect is an accident of the current
 * wiring, and the guard is the statement of intent.
 *
 * @param props Diagram id and, for the share viewer, the already-resolved diagram; see
 *   {@link DiagramCanvasProps}.
 * @returns The canvas, a loading state, or the failure that stopped it loading.
 */
export function DiagramCanvas({ diagramId, readOnly = false, initialDiagram }: DiagramCanvasProps) {
  const { fitView, getNodes, getNodesBounds, screenToFlowPosition } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onViewportChange,
    setDiagram,
    applyRemoteSnapshot,
    acknowledgeRemoteOperation,
    addNode,
    removeSelected,
    setSelectedNode,
    setSelectedEdge,
    undo,
    redo,
    dirty,
    markSaving,
    markSaved,
    markSaveError,
    title,
    description,
    printMode,
    setPrintMode,
    paletteOpen,
    propertiesOpen,
    minimapOpen
  } = useDiagramStore();

  const [loadError, setLoadError] = useState<string | null>(null);
  const diagramLoaded = useDiagramStore((state) => state.diagramId !== null);

  // Who made the change this tab is currently announcing, or `null` when there is nothing to
  // announce. Local component state rather than store state: it describes this tab's notification
  // area, nothing else reads it, and putting it in the store would make a piece of transient UI
  // part of the document's model.
  //
  // It holds the origin rather than a boolean because a person's change and an agent's need
  // different wording, and the identity cannot tell them apart — an agent authenticates as
  // whoever configured it, so "alice@example.com changed this" is true of both.
  const [remoteChange, setRemoteChange] = useState<ChangeOrigin | null>(null);
  const [participants, setParticipants] = useState<PresenceParticipant[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
  const [remoteSelections, setRemoteSelections] = useState<RemoteSelection[]>([]);

  // The assistant conversation, held here for the same reason `remoteChange` is: it describes this
  // tab's view of a stream of frames, nothing else reads it, and putting it in the editor store
  // would make it part of the document — which the whole-graph REST fallback writes back to D1.
  const [chatTranscript, setChatTranscript] = useState<ChatTranscriptEntry[]>([]);
  const [chatInFlight, setChatInFlight] = useState(false);

  /**
   * The live connection this tab may write through, or `null` before it is open and after it
   * closes. A ref rather than state because rendering does not depend on the object itself; the
   * autosave timer reads it imperatively at the moment it fires.
   */
  const liveSocketRef = useRef<WebSocket | null>(null);

  /**
   * Last graph this tab dispatched or adopted from a session snapshot.
   *
   * The debounce diffs this against the optimistic canvas to derive operations. Updated
   * optimistically as each operation is sent, so another local edit made before its echo is
   * described relative to the graph the session will have once those earlier operations land.
   */
  const dispatchedGraphRef = useRef<ClientGraph | null>(null);

  /**
   * Last graph the session has confirmed, before this tab's still-pending optimistic operations.
   *
   * Separate from {@link dispatchedGraphRef} because another editor's operation can be ordered
   * before an operation this tab has sent but not yet had echoed. The confirmed graph follows the
   * server's order; the optimistic graph shown to the user is rebuilt as confirmed plus pending, so
   * a network interleaving cannot silently reverse two conflicting edits.
   */
  const confirmedGraphRef = useRef<ClientGraph | null>(null);

  /**
   * Operations still waiting for their acceptance echo, in dispatch order.
   *
   * A map rather than a set because reconciling a remote operation means replaying these over the
   * newly confirmed graph. JavaScript maps preserve insertion order, which is the same order this
   * tab sent them in.
   */
  const pendingOperationsRef = useRef(new Map<string, OperationAppliedFrame['operation']>());

  /**
   * Time of the last cursor frame sent from this tab. A ref avoids rendering on every pointer move.
   */
  const lastCursorSentAtRef = useRef(0);

  /**
   * The turn this tab is waiting on, or `null` when none is in flight.
   *
   * It is also what decides whether an `ai-chat` operation belongs to this tab's own conversation,
   * which is what suppresses the "updated by somebody else" notice for a change the visitor asked
   * for a second ago.
   */
  const activeChatRequestIdRef = useRef<string | null>(null);

  /**
   * The assistant bubble tokens are currently appending to, or `null` when the next token should
   * open a fresh one.
   *
   * Cleared by {@link appendInterruptingEntry} every time a non-assistant entry is appended, which
   * is what keeps the transcript chronological: a turn typically narrates, calls tools, then
   * narrates again, and a bubble left anchored where its first token landed would collect the
   * closing summary _above_ the tool activity that preceded it.
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

  /**
   * Whether the turn in flight has added or removed a node, so one layout pass is owed when it
   * completes. A ref rather than state: it is read once, at the end of the turn, and a re-render
   * per mutation would be a render nobody is waiting for.
   */
  const chatChangedNodeCountRef = useRef(false);

  /**
   * Whether this tab's own post-turn layout write is still in flight.
   *
   * A whole-graph save is broadcast back as a {@link SnapshotFrame} to every connection including
   * the one that made it, so without this the visitor would be told another editor had changed the
   * diagram they had just rearranged themselves. It only has to cover the window before the write
   * resolves: once it has, this tab's recorded `updatedAt` is the server's own, and the echo is
   * discarded as stale by the snapshot's ordinary newness rule.
   */
  const layoutWriteInFlightRef = useRef(false);

  useEffect(() => {
    // The share viewer's diagram arrived with the props, resolved anonymously by `/api/shares`.
    // Calling `getDiagram` here would be a request an anonymous visitor is not authorized to
    // make, and would answer `401` for a page they are entitled to see.
    if (readOnly && initialDiagram) {
      const parsed = parseGraphData(initialDiagram.graphData);
      // No timestamp: the anonymous share projection deliberately carries none, and this posture
      // opens no live channel, so there is nothing for one to be compared against.
      setDiagram(
        diagramId,
        initialDiagram.title,
        initialDiagram.description ?? '',
        parsed.nodes,
        parsed.edges,
        parsed.viewport
      );
      return undefined;
    }

    let cancelled = false;

    // `getAccessibleDiagram` rather than `getDiagram`: the editor needs the caller's role as well
    // as the diagram, to decide whether to offer the owner-only toolbar controls. One request
    // returns both, so the two answers cannot disagree — which a second request could, if
    // somebody's access changed between them.
    getAccessibleDiagram(diagramId)
      .then(({ diagram, role }) => {
        // The guard matters because the store outlives this component: committing a diagram that
        // arrived after the visitor navigated away would leave the next editor showing it.
        if (cancelled) {
          return;
        }
        const parsed = parseGraphData(diagram.graphData);
        setParticipants([]);
        setRemoteCursors([]);
        setRemoteSelections([]);
        // A conversation belongs to the connection it ran on: the session keeps its history per
        // socket, so a transcript carried into a different diagram would be one this tab
        // remembers and the model has never seen.
        setChatTranscript([]);
        setChatInFlight(false);
        dispatchedGraphRef.current = { edges: parsed.edges, nodes: parsed.nodes };
        confirmedGraphRef.current = { edges: parsed.edges, nodes: parsed.nodes };
        pendingOperationsRef.current.clear();
        setDiagram(
          diagramId,
          diagram.title,
          diagram.description ?? '',
          parsed.nodes,
          parsed.edges,
          parsed.viewport,
          diagram.updatedAt,
          role
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Could not load diagram.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [diagramId, setDiagram, readOnly, initialDiagram]);

  // Save after the same 500 ms of quiet the editor has always used. While the live socket is open,
  // the debounce describes the optimistic canvas as ordered operations; otherwise it falls back to
  // the whole-graph REST save. There is never a window where both write paths are active.
  useEffect(() => {
    if (readOnly || !dirty) {
      return undefined;
    }

    const timer = setTimeout(() => {
      void (async () => {
        markSaving();
        // Read at this moment rather than captured when the effect ran, so a change made during the
        // debounce is included rather than silently dropped.
        const state = useDiagramStore.getState();
        const socket = liveSocketRef.current;
        const before = dispatchedGraphRef.current;

        if (socket?.readyState === WebSocket.OPEN && before !== null) {
          try {
            const operations = diffGraphOperations(before, state);

            for (const operation of operations) {
              const operationId = crypto.randomUUID();
              pendingOperationsRef.current.set(operationId, operation);
              const frame: ClientFrame = { operation, operationId, type: 'operation' };
              socket.send(JSON.stringify(frame));
            }
            // The exact optimistic graph rather than one reconstructed by replaying the operations.
            // Domain normalisation may add defaults (for example an empty description), and using
            // that reconstructed form would make the next debounce "discover" a change the user
            // never made and send a compensating operation.
            dispatchedGraphRef.current = { edges: state.edges, nodes: state.nodes };

            if (operations.length === 0) {
              // Only non-document React Flow state changed, such as selection. There is nothing to
              // persist and therefore no echo to clear the save indicator.
              markSaved(state.updatedAt ?? new Date().toISOString());
            }
          } catch (error) {
            // Diffing or sending failed before the session could answer. Requesting a snapshot
            // restores one known base; until it arrives the dirty graph remains available for the
            // REST fallback if the socket closes.
            markSaveError(error instanceof Error ? error.message : 'Failed to save.');
            socket.send(JSON.stringify({ type: 'resync' } satisfies ClientFrame));
          }
          return;
        }

        try {
          const graphData = JSON.stringify({
            edges: state.edges,
            nodes: state.nodes,
            viewport: state.viewport
          });
          const updatedAt = await saveDiagramGraph(diagramId, graphData);
          dispatchedGraphRef.current = { edges: state.edges, nodes: state.nodes };
          // The server's own timestamp, recorded so a live snapshot describing an older version
          // than this save is discarded instead of reverting what was just written.
          markSaved(updatedAt);
        } catch (error) {
          markSaveError(error instanceof Error ? error.message : 'Failed to save.');
        }
      })();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [readOnly, dirty, diagramId, markSaving, markSaved, markSaveError]);

  /**
   * Appends a non-assistant transcript entry, closing out any assistant bubble being streamed to.
   *
   * Closing the bubble is what keeps the transcript chronological, and it is the whole reason this
   * is a named function rather than a bare `setChatTranscript`. A turn narrates, calls tools, then
   * narrates again; every entry here is a plain end-append, so a bubble left anchored where its
   * first token landed would go on collecting that later prose and put the turn's closing summary
   * _above_ the tool activity it followed. Clearing the anchor makes the next token open a fresh
   * bubble beneath this entry instead.
   *
   * @param entry The status, action, docs or error entry to append.
   * @returns Nothing.
   */
  const appendInterruptingEntry = useCallback((entry: ChatTranscriptEntry): void => {
    activeAssistantEntryIdRef.current = null;
    setChatTranscript((current) => [...current, entry]);
  }, []);

  /**
   * Lays the diagram out once, after a turn that changed how many nodes are on the canvas.
   *
   * The assistant places new nodes on a simple staggered grid, which is legible enough to watch a
   * diagram being built but is not a layout. One ELK pass at the end of the turn is what turns it
   * into one, and it runs here — in the browser — rather than in the session, because ELK cannot
   * run inside `workerd` at all and because the editor already owns this exact algorithm for its
   * own toolbar button.
   *
   * The result is persisted through the existing whole-graph route rather than as operations: a
   * whole-graph replace is not expressible as a `GraphOperation`, and the route already reaches the
   * same session object, so this needs no new endpoint and no new frame.
   *
   * @returns A promise fulfilled once the layout has been applied and persisted, or once the
   *   failure has been absorbed. A failed layout leaves the diagram exactly as the turn left it,
   *   which is a usable diagram — so it is swallowed rather than reported, in keeping with the
   *   title save's own reasoning.
   */
  const runPostTurnLayout = useCallback(async (): Promise<void> => {
    const state = useDiagramStore.getState();
    if (state.nodes.length === 0) {
      return;
    }

    try {
      const result = await computeAutoLayout(state.nodes, state.edges, 'DOWN');
      if (result === null) {
        return;
      }

      // One history entry for the whole pass, so a visitor who dislikes the arrangement gets their
      // diagram back with one Ctrl+Z rather than one press per node.
      useDiagramStore.getState().pushHistory();
      useDiagramStore.getState().setNodes(result.nodes);
      useDiagramStore.getState().setEdges(result.edges);

      layoutWriteInFlightRef.current = true;
      try {
        // The id is read from the store along with everything else this function reads
        // imperatively, rather than closed over: a callback that captured the prop would have to
        // be rebuilt — and the socket effect that calls it re-run — every time the editor's
        // identity changed, for a value the store already holds.
        const updatedAt = await saveDiagramGraph(
          useDiagramStore.getState().diagramId as string,
          JSON.stringify({
            edges: result.edges,
            nodes: result.nodes,
            viewport: useDiagramStore.getState().viewport
          })
        );
        // The graph the server now holds is the graph this tab dispatched, so the debounce must
        // not rediscover the layout as an unsent change and send it a second time as operations.
        dispatchedGraphRef.current = { edges: result.edges, nodes: result.nodes };
        confirmedGraphRef.current = { edges: result.edges, nodes: result.nodes };
        // Read imperatively rather than closed over, as everything else in this function is: the
        // store's actions are stable, and taking them from the current state keeps this callback
        // out of the dependency churn the save debounce already avoids the same way.
        useDiagramStore.getState().markSaved(updatedAt);
      } finally {
        layoutWriteInFlightRef.current = false;
      }

      setTimeout(() => void fitView({ duration: LAYOUT_FIT_DURATION_MS }), LAYOUT_FIT_DELAY_MS);
    } catch {
      /* The conversation's own changes are already persisted; only the tidying failed. */
    }
  }, [fitView]);

  // Live sync. Both directions use the same socket: another editor's or agent's operation appears
  // here immediately, and the save debounce above sends this tab's own operations back. The REST
  // whole-graph save remains only as a resilience fallback while the socket is unavailable.
  //
  // Opened once per diagram and closed on unmount, so navigating between diagrams never leaves a
  // socket listening for a document that is no longer on screen. Not opened at all in read-only
  // mode: an anonymous share viewer has no Access session, so the upgrade would be refused, and a
  // failed connection in a posture that was never meant to have one would be pure noise.
  useEffect(() => {
    if (readOnly) {
      return undefined;
    }

    const socket = new WebSocket(diagramLiveUrl(diagramId));
    const pendingOperations = pendingOperationsRef.current;
    const stoppedRequestIds = stoppedRequestIdsRef.current;

    // A turn belongs to the connection it ran on, so nothing from a previous one may be waited on
    // here. The transcript itself is cleared by the load effect above, which is where the rest of
    // this tab's per-diagram state is reset; only the bookkeeping refs belong with the socket.
    activeChatRequestIdRef.current = null;
    activeAssistantEntryIdRef.current = null;
    streamedAnyTokenRef.current = false;
    chatChangedNodeCountRef.current = false;
    stoppedRequestIds.clear();

    /**
     * Makes the live path available to the save debounce.
     *
     * @returns Nothing.
     */
    const onOpen = (): void => {
      liveSocketRef.current = socket;
    };

    /**
     * Removes a socket that can no longer carry writes, activating the REST fallback on the next
     * debounce. Guarded by identity so an old socket closing after navigation cannot clear a newer
     * diagram's connection.
     *
     * @returns Nothing.
     */
    const onUnavailable = (): void => {
      if (liveSocketRef.current === socket) {
        liveSocketRef.current = null;
      }
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('close', onUnavailable);
    socket.addEventListener('error', onUnavailable);
    // The test double begins open because it only models post-handshake behaviour. A real browser
    // begins CONNECTING and reaches this assignment through `onOpen` instead.
    if (socket.readyState === WebSocket.OPEN) {
      liveSocketRef.current = socket;
    }

    /**
     * Asks the session to resend the whole graph.
     *
     * Called when this tab can no longer apply operations safely — it has missed a frame, or an
     * operation did not apply cleanly, either of which means its canvas may already differ from
     * what is stored. Silent divergence is the characteristic failure of operation-based sync, so
     * the tab says so rather than carrying on.
     *
     * @returns Nothing.
     */
    const requestResync = (): void => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resync' }));
      }
    };

    /**
     * Applies one frame from the live session.
     *
     * The `switch` is exhaustive over `SessionFrame` by construction, so adding a frame to
     * `src/live-sync-protocol.ts` fails the build here until it is handled — which is the reason
     * that module is shared with the Worker rather than redeclared on each side.
     *
     * @param event Message event carrying one JSON-encoded frame.
     * @returns Nothing.
     */
    const onMessage = (event: MessageEvent): void => {
      let frame: SessionFrame;
      try {
        frame = JSON.parse(String(event.data)) as SessionFrame;
      } catch {
        // A frame this client cannot parse is not something it can act on, and there is nothing
        // useful to tell the visitor about it: their diagram is intact and their own saves are
        // unaffected. Ignoring it keeps a malformed push from breaking a working editor.
        return;
      }

      switch (frame.type) {
        case 'snapshot': {
          const parsed = parseGraphData(frame.graphData);
          const confirmed = { edges: parsed.edges, nodes: parsed.nodes };
          const current = useDiagramStore.getState();
          const previousDispatch = dispatchedGraphRef.current;
          const unsent =
            previousDispatch === null ? [] : diffGraphOperations(previousDispatch, current);
          confirmedGraphRef.current = confirmed;

          // A whole-graph save from another editor may interleave with both operations already in
          // flight and a newer local edit the debounce has not sent yet. The snapshot is the new
          // confirmed base; replay pending first, then unsent, preserving the server's order and
          // everything the user can still see. A resync after a rejection has already removed the
          // rejected operation from the pending map, so the same rule rolls it back.
          let dispatched = confirmed;
          let optimistic = confirmed;
          try {
            dispatched = replayPendingOperations(
              confirmed,
              pendingOperationsRef.current.values(),
              current.viewport
            );
            optimistic = replayPendingOperations(dispatched, unsent, current.viewport);
          } catch {
            // An optimistic edit no longer applies to the snapshot — another editor removed its
            // target. Nothing can make that edit real now, so adopt the server graph and stop
            // replaying it rather than presenting a state the server will refuse.
            pendingOperationsRef.current.clear();
            dispatched = confirmed;
            optimistic = confirmed;
          }
          dispatchedGraphRef.current = dispatched;
          const applied = applyRemoteSnapshot(
            optimistic.nodes,
            optimistic.edges,
            frame.updatedAt,
            frame.sequence
          );
          // Announced only when the store took it *and* it describes somebody's change. A
          // snapshot with no origin is this tab's own connect or resync answer, which the visitor
          // did not need telling about, and a stale one changed nothing. A whole-graph save is
          // echoed to its own author too, so this tab's in-flight layout write is excluded —
          // otherwise tidying the diagram would announce itself as somebody else's edit.
          if (applied && frame.origin !== null && !layoutWriteInFlightRef.current) {
            setRemoteChange(frame.origin);
          }
          return;
        }
        case 'operation_applied': {
          const ownOperation =
            frame.operationId === null
              ? undefined
              : pendingOperationsRef.current.get(frame.operationId);

          try {
            const current = useDiagramStore.getState();
            const previousDispatch = dispatchedGraphRef.current;
            let confirmed = confirmedGraphRef.current;
            if (confirmed === null || previousDispatch === null) {
              requestResync();
              return;
            }

            // Edits made after the last debounce are on the canvas but not in the pending map yet.
            // Preserve them separately: pending operations have already been sent and must be
            // replayed before these unsent ones.
            const unsent = diffGraphOperations(previousDispatch, current);
            const result = acknowledgeRemoteOperation(frame.updatedAt, frame.sequence);
            if (result === 'gap') {
              requestResync();
              return;
            }
            if (result === 'duplicate') {
              return;
            }

            if (frame.origin === 'ai-chat') {
              // Narrated from the **confirmed** broadcast rather than from a status frame, and
              // that is the whole rule: a status is necessarily emitted before the operation is
              // applied, so narrating from one announces changes the session then rejects. One
              // confirmed operation is exactly one line, and a rejected one is no line at all.
              //
              // Described against the graph as it stood *before* the mutation: a `remove_node`
              // target is gone from the store the instant the reconciliation below runs, and
              // `describeOperation` has no other way to learn what it used to be.
              appendInterruptingEntry({
                id: nextTranscriptEntryId(),
                kind: 'action',
                text: describeOperation(frame.operation, current.nodes, current.edges)
              });
              if (frame.operation.kind === 'add_node' || frame.operation.kind === 'remove_node') {
                chatChangedNodeCountRef.current = true;
              }
            }

            confirmed = applyClientOperation(confirmed, frame.operation, current.viewport);
            confirmedGraphRef.current = confirmed;
            if (ownOperation !== undefined && frame.operationId !== null) {
              pendingOperationsRef.current.delete(frame.operationId);
            } else if (frame.origin !== 'ai-chat' || activeChatRequestIdRef.current === null) {
              // An `ai-chat` operation carries no operation id — the session authored it, so there
              // is no optimistic edit of this tab's to reconcile it against — which means the
              // ordinary "was this mine?" test cannot tell the tab that is chatting from one
              // quietly watching. Having a turn in flight is that signal instead: the chatting tab
              // already sees the change narrated in its own transcript and does not need telling
              // that somebody changed the canvas, while a passive collaborator gets the notice
              // exactly as they would for a person's edit. It is an approximation rather than a
              // per-turn correlation, and an exact one in practice: the composer refuses to send a
              // second message while one is in flight, so a tab has at most one turn at a time.
              setRemoteChange(frame.origin);
            }

            // Rebuild the optimistic canvas in the **server's** order: confirmed operation first,
            // then this tab's remaining pending changes, then its newer unsent changes. This keeps
            // a remote operation that interleaved with local editing from silently reversing the
            // two or dropping what the user just typed.
            const dispatched = replayPendingOperations(
              confirmed,
              pendingOperationsRef.current.values(),
              current.viewport
            );
            const optimistic = replayPendingOperations(dispatched, unsent, current.viewport);
            dispatchedGraphRef.current = dispatched;
            useDiagramStore.setState({ edges: optimistic.edges, nodes: optimistic.nodes });

            if (ownOperation !== undefined && pendingOperationsRef.current.size === 0) {
              // `dirty` may still be true because React has not yet committed the state update the
              // debounce dispatched from. Clearing it is correct only when the *current* graph is
              // still the optimistic graph now confirmed; a newer edit produces a non-empty diff
              // and keeps the flag set for the next debounce.
              const currentAfterReconcile = useDiagramStore.getState();
              const newlyUnsent = diffGraphOperations(dispatched, currentAfterReconcile);
              if (newlyUnsent.length === 0) {
                markSaved(frame.updatedAt);
              }
            }
          } catch {
            requestResync();
          }
          return;
        }
        case 'presence_snapshot':
          setParticipants(frame.participants);
          return;
        case 'presence_joined':
          setParticipants((current) =>
            current.some((participant) => participant.email === frame.email)
              ? current
              : [...current, { color: frame.color, email: frame.email }]
          );
          return;
        case 'presence_left':
          setParticipants((current) =>
            current.filter((participant) => participant.email !== frame.email)
          );
          setRemoteCursors((current) => current.filter((cursor) => cursor.email !== frame.email));
          setRemoteSelections((current) =>
            current.filter((selection) => selection.email !== frame.email)
          );
          return;
        case 'cursor_moved':
          setRemoteCursors((current) => {
            const cursor: RemoteCursor = {
              color: frame.color,
              email: frame.email,
              x: frame.x,
              y: frame.y
            };
            return [...current.filter((entry) => entry.email !== frame.email), cursor];
          });
          return;
        case 'selection_changed':
          setRemoteSelections((current) => {
            const selection: RemoteSelection = {
              color: frame.color,
              edgeId: frame.edgeId,
              email: frame.email,
              nodeId: frame.nodeId
            };
            return [...current.filter((entry) => entry.email !== frame.email), selection];
          });
          return;
        case 'operation_rejected':
          // The server did not apply one optimistic edit. A snapshot is the only honest rollback:
          // replaying assumptions about why it failed would be another opportunity to diverge.
          pendingOperationsRef.current.delete(frame.operationId);
          requestResync();
          markSaveError(frame.detail);
          return;
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
          setChatTranscript((current) =>
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
          // Read synchronously, before the reset below, for the reason the token arm documents.
          const streamedAnyToken = streamedAnyTokenRef.current;
          if (!wasStopped && !streamedAnyToken) {
            // Nothing streamed — an empty answer, or a whole response that arrived unstreamed —
            // so there is no bubble showing it and this frame's copy is the only one there is.
            //
            // When tokens *did* stream there is deliberately nothing to do. `assistantText` is by
            // construction the concatenation of exactly those tokens, and a turn may now own
            // several bubbles because tool activity splits them, so rewriting "the" bubble with
            // the whole answer would duplicate every earlier bubble's prose into the last one.
            const { assistantText } = frame;
            setChatTranscript((current) => [
              ...current,
              {
                id: nextTranscriptEntryId(),
                kind: 'assistant',
                stopped: false,
                text: assistantText
              }
            ]);
          }
          if (activeChatRequestIdRef.current === frame.clientRequestId) {
            activeChatRequestIdRef.current = null;
            activeAssistantEntryIdRef.current = null;
            streamedAnyTokenRef.current = false;
            setChatInFlight(false);
            if (chatChangedNodeCountRef.current) {
              chatChangedNodeCountRef.current = false;
              void runPostTurnLayout();
            }
          }
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
          if (activeChatRequestIdRef.current === frame.clientRequestId) {
            activeChatRequestIdRef.current = null;
            activeAssistantEntryIdRef.current = null;
            streamedAnyTokenRef.current = false;
            setChatInFlight(false);
            // A failed turn keeps whatever it had already applied — each operation was persisted
            // and broadcast on its own — so the nodes it added still deserve their one pass.
            if (chatChangedNodeCountRef.current) {
              chatChangedNodeCountRef.current = false;
              void runPostTurnLayout();
            }
          }
          return;
        }
        case 'diagram_renamed':
          // Set directly rather than through `setTitle`/`setDescription`, which would mark the
          // graph dirty: the `rename_diagram` tool call that produced this broadcast already
          // persisted both fields, so there is nothing here to save. The title debounce still
          // runs, because it watches `title`, and writes the value back unchanged a second later
          // — an idempotent write rather than a correctness problem, and cheaper to leave than to
          // suppress with a flag that would then have to be right in every other path.
          useDiagramStore.setState({
            description: frame.description ?? '',
            title: frame.title
          });
          return;
        case 'connected':
          // Acknowledgement only. The identity is echoed from the socket attachment the server
          // pinned, and the editor already knows who it is, so there is nothing to apply.
          return;
        case 'error':
          // Sent only in answer to a frame this client sent that the session could not read at
          // all. Nothing of the visitor's has failed — their graph and their saves are untouched
          // — so there is nothing useful to show them.
          return;
      }
    };

    socket.addEventListener('message', onMessage);

    return () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('close', onUnavailable);
      socket.removeEventListener('error', onUnavailable);
      socket.removeEventListener('message', onMessage);
      onUnavailable();
      pendingOperations.clear();
      stoppedRequestIds.clear();
      // Closed unconditionally, including while still connecting: a socket abandoned mid-handshake
      // would otherwise finish opening after the component has gone and stay open until the tab
      // is closed.
      socket.close();
    };
  }, [
    readOnly,
    diagramId,
    applyRemoteSnapshot,
    acknowledgeRemoteOperation,
    appendInterruptingEntry,
    markSaved,
    markSaveError,
    runPostTurnLayout
  ]);

  // The last line of defence for unsaved work: a visitor who closes the tab within the debounce
  // window is asked first. The browser shows its own wording, so there is no message to provide.
  // Not attached at all in read-only mode, which never has unsaved work to lose.
  useEffect(() => {
    if (readOnly) {
      return undefined;
    }

    const handler = (event: BeforeUnloadEvent): void => {
      if (useDiagramStore.getState().dirty) {
        event.preventDefault();
      }
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [readOnly]);

  // The title saves on its own timer rather than with the graph: it is metadata, it changes a
  // character at a time, and bundling it with the graph would send the whole canvas on every
  // keystroke. A failure here is deliberately silent — the status bar reports the graph's save
  // state, which is the one a visitor is watching, and a toast about a title that will be retried
  // on the next keystroke would be noise.
  useEffect(() => {
    if (readOnly || !diagramLoaded) {
      return undefined;
    }

    const timer = setTimeout(() => {
      updateDiagram(diagramId, { title }).catch(() => {
        /* Retried by the next keystroke; the graph's own save state is what is reported. */
      });
    }, TITLE_SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [readOnly, title, diagramLoaded, diagramId]);

  // Fit the loaded diagram into view once it can actually be measured. React Flow's own `fitView`
  // prop fits at mount, against nodes that have no size yet: `CFNode` is sized by its content, so
  // at that instant every node is zero by zero and the computed viewport leaves the real diagram
  // off screen. `useNodesInitialized()` turns true only once every node has been measured, which
  // is the first moment the fit can be correct. The ref keeps it to once per mount, so it never
  // fights a visitor's own panning afterwards.
  const fittedOnLoadRef = useRef(false);
  useEffect(() => {
    if (fittedOnLoadRef.current || !diagramLoaded || !nodesInitialized) {
      return;
    }
    fittedOnLoadRef.current = true;
    void fitView({ duration: 0 });
  }, [diagramLoaded, nodesInitialized, fitView]);

  // Print mode. The button only sets the flag; everything printing actually requires happens
  // here, because all of it is about the document and the viewport rather than about a control.
  //
  // Four things have to be true for a printed diagram to be usable, and only the last is
  // obvious:
  //
  // - **A light colour scheme, forced.** A dark-mode diagram prints as a page of black ink. The
  //   override is an inline `color-scheme` rather than a class, because that is what drives
  //   every `light-dark()` value in the stylesheet — see `../../lib/theme.ts`.
  // - **An orientation matching the diagram.** A wide architecture on a portrait page is
  //   scaled down to nothing. The `@page` rule is injected rather than written in the stylesheet
  //   because the choice depends on this diagram's actual shape.
  // - **A fitted viewport.** Printing captures the page as it stands, so whatever the visitor had
  //   panned to is what would land on the paper.
  // - **The dialog itself**, one short wait later, so the browser has painted the fit first.
  //
  // Every one of them is undone on the way out, including when the effect is torn down by an
  // unmount mid-print: leaving the scheme forced would silently disable the appearance control.
  useEffect(() => {
    if (!printMode) {
      return undefined;
    }

    const previousColorScheme = document.documentElement.style.colorScheme;
    document.documentElement.style.colorScheme = 'light';
    document.body.classList.add(PRINT_MODE_BODY_CLASS);

    const flowNodes = getNodes();
    // Landscape for an empty diagram: there is no shape to infer one from, and a printed page of
    // a blank canvas is the same either way.
    const bounds = flowNodes.length > 0 ? getNodesBounds(flowNodes) : null;
    const isLandscape = bounds === null || bounds.width > bounds.height;

    const orientationStyle = document.createElement('style');
    orientationStyle.id = PRINT_ORIENTATION_STYLE_ID;
    orientationStyle.textContent = `@page { size: ${
      isLandscape ? 'landscape' : 'portrait'
    }; margin: 0.5in; }`;
    document.head.appendChild(orientationStyle);

    /**
     * Returns the document to the state it was in before print mode.
     *
     * @returns Nothing.
     */
    const restoreDocument = (): void => {
      document.documentElement.style.colorScheme = previousColorScheme;
      document.body.classList.remove(PRINT_MODE_BODY_CLASS);
      document.getElementById(PRINT_ORIENTATION_STYLE_ID)?.remove();
    };

    /**
     * Leaves print mode once the browser's print dialog has closed.
     *
     * Listening for `afterprint` rather than assuming the dialog succeeded is what returns the
     * editor to normal after a cancelled print as well as a completed one.
     *
     * @returns Nothing.
     */
    const exitPrintMode = (): void => {
      restoreDocument();
      setPrintMode(false);
    };

    window.addEventListener('afterprint', exitPrintMode);

    const frame = requestAnimationFrame(() => {
      void fitView({ duration: 0 });
      setTimeout(() => window.print(), PRINT_DIALOG_DELAY_MS);
    });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', exitPrintMode);
      restoreDocument();
    };
  }, [printMode, fitView, getNodes, getNodesBounds, setPrintMode]);

  /**
   * Adds one catalogue service to the canvas at a screen point, ignoring an unknown type.
   *
   * Both ways of adding a service go through here — dropping one and activating one from the
   * keyboard — so the two cannot drift into producing differently-shaped nodes, and the "is this a
   * product we know?" decision is taken once. A drag from outside the palette (a file, a link,
   * another tab) carries no type of ours, and inventing a node for it would be surprising; the
   * keyboard path cannot produce an unknown type at all, because the palette only renders the
   * catalogue, but it inherits the same guard for free rather than restating it.
   *
   * @param typeId Catalogue type to add. Anything the catalogue does not define is ignored.
   * @param screenPoint Where on screen the node should appear, converted to canvas coordinates here
   *   so neither caller has to know about React Flow's viewport transform.
   * @returns Nothing.
   */
  const addCatalogueNode = useCallback(
    (typeId: string, screenPoint: { x: number; y: number }) => {
      const typeDef = NODE_TYPE_MAP.get(typeId);
      if (!typeId || !typeDef) {
        return;
      }

      addNode({
        data: { description: '', label: typeDef.label, typeId },
        id: `${typeId}-${Date.now()}`,
        position: screenToFlowPosition(screenPoint),
        type: CF_NODE_TYPE
      });
    },
    [screenToFlowPosition, addNode]
  );

  /**
   * Adds a service dropped from the palette, at the point it was dropped.
   *
   * @param event Drop event carrying the catalogue type.
   * @returns Nothing.
   */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      addCatalogueNode(event.dataTransfer.getData('application/cf-node-type'), {
        x: event.clientX,
        y: event.clientY
      });
    },
    [addCatalogueNode]
  );

  /**
   * Allows a drop to land. Without this the browser's default refuses it and the drop never fires.
   *
   * @param event Drag-over event.
   * @returns Nothing.
   */
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  /**
   * Adds a service activated from the palette without a pointer, at the centre of the viewport.
   *
   * The centre because there is no drop point to use: a keyboard activation has no coordinates, and
   * the middle of what the visitor is looking at is where they can see the result arrive.
   *
   * @param typeId Catalogue type to add.
   * @returns Nothing.
   */
  const onAddNodeFromPalette = useCallback(
    (typeId: string) => {
      addCatalogueNode(typeId, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
    },
    [addCatalogueNode]
  );

  /**
   * Sends an ephemeral awareness frame only while this tab's live socket is usable.
   *
   * @param frame Cursor or selection frame; graph operations use the durable debounce path instead.
   * @returns Nothing.
   */
  const sendAwareness = useCallback(
    (frame: Extract<ClientFrame, { type: 'cursor_moved' | 'selection_changed' }>): void => {
      const socket = liveSocketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    },
    []
  );

  /**
   * Sends one message to the assistant over the same socket every other change travels on.
   *
   * The person's own line is appended to the transcript here rather than waiting for the session to
   * echo it, because the session never does: the frame carries no author, exactly as an operation
   * does not, and what the visitor typed is already known locally.
   *
   * @param text The person's message, already trimmed by the composer.
   * @returns Whether the frame reached the socket. `false` leaves the composer's draft in place, so
   *   a message typed while the connection was dropping is not lost.
   */
  const sendChatMessage = useCallback((text: string): boolean => {
    const socket = liveSocketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    const clientRequestId = crypto.randomUUID();
    activeChatRequestIdRef.current = clientRequestId;
    activeAssistantEntryIdRef.current = null;
    streamedAnyTokenRef.current = false;
    chatChangedNodeCountRef.current = false;
    setChatInFlight(true);
    setChatTranscript((current) => [
      ...current,
      { id: nextTranscriptEntryId(), kind: 'user', text }
    ]);
    socket.send(
      JSON.stringify({ clientRequestId, text, type: 'chat_message' } satisfies ClientFrame)
    );
    return true;
  }, []);

  /**
   * Stops rendering the in-flight turn's remaining answer.
   *
   * Client-side only, and the wording in the panel says so. There is no cancellation frame in the
   * protocol: the turn is running inside the Durable Object, which deliberately completes a turn
   * whose originator has disconnected entirely, so there is nothing this tab could send that would
   * interrupt it. Every mutation the turn still makes arrives as an ordinary broadcast and is still
   * applied to the canvas; only this tab's narration of the rest is suppressed.
   *
   * @returns Nothing. A no-op when no turn is in flight.
   */
  const stopChatTurn = useCallback((): void => {
    const clientRequestId = activeChatRequestIdRef.current;
    if (clientRequestId === null) {
      return;
    }

    stoppedRequestIdsRef.current.add(clientRequestId);
    const bubbleId = activeAssistantEntryIdRef.current;
    if (bubbleId !== null) {
      setChatTranscript((current) =>
        current.map((entry) =>
          entry.id === bubbleId && entry.kind === 'assistant' ? { ...entry, stopped: true } : entry
        )
      );
    }

    activeChatRequestIdRef.current = null;
    activeAssistantEntryIdRef.current = null;
    streamedAnyTokenRef.current = false;
    setChatInFlight(false);
  }, []);

  /**
   * Clears this tab's transcript.
   *
   * Local only. The session's own per-connection history is not reset, because no frame in this
   * protocol asks it to — every frame either starts a turn or reports one's outcome — and closing
   * and reopening the socket to achieve it would also discard this tab's presence and every
   * operation still in flight. The resulting gap is small and deliberate: the reader gets a clean
   * panel, and the model remembers a conversation that is no longer on screen until the connection
   * ends.
   *
   * @returns Nothing.
   */
  const clearChatTranscript = useCallback((): void => {
    setChatTranscript([]);
    // An in-flight turn's next token opens a fresh bubble rather than trying to append to an id
    // the now-empty transcript no longer contains.
    activeAssistantEntryIdRef.current = null;
  }, []);

  const onNodeClick = useCallback(
    (_event: unknown, node: { id: string }) => {
      setSelectedNode(node.id);
      sendAwareness({ edgeId: null, nodeId: node.id, type: 'selection_changed' });
    },
    [sendAwareness, setSelectedNode]
  );

  const onEdgeClick = useCallback(
    (_event: unknown, edge: { id: string }) => {
      setSelectedEdge(edge.id);
      sendAwareness({ edgeId: edge.id, nodeId: null, type: 'selection_changed' });
    },
    [sendAwareness, setSelectedEdge]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    sendAwareness({ edgeId: null, nodeId: null, type: 'selection_changed' });
  }, [sendAwareness, setSelectedNode, setSelectedEdge]);

  /**
   * Relays the local cursor at most fifteen times per second.
   *
   * @param event Canvas pointer move event.
   * @returns Nothing.
   */
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const now = performance.now();
      if (now - lastCursorSentAtRef.current < CURSOR_THROTTLE_MS) {
        return;
      }
      lastCursorSentAtRef.current = now;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      sendAwareness({ type: 'cursor_moved', x: position.x, y: position.y });
    },
    [screenToFlowPosition, sendAwareness]
  );

  /**
   * The canvas's keyboard shortcuts: delete the selection, undo, and redo.
   *
   * @param event Key event from the canvas region.
   * @returns Nothing.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Nothing on a read-only canvas can be deleted, undone or redone, so the shortcuts are not
      // merely inert here — they must not swallow a Backspace the browser would otherwise treat
      // as "go back".
      if (readOnly) {
        return;
      }

      const target = event.target as HTMLElement;
      // Deleting the selection while somebody is editing a text field would turn Backspace in the
      // title box into "delete the selected node", which is the single most destructive way this
      // editor could misread a keystroke.
      const isEditing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if ((event.key === 'Delete' || event.key === 'Backspace') && !isEditing) {
        removeSelected();
      }
      if (event.ctrlKey && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'Z') {
        event.preventDefault();
        redo();
      }
    },
    [readOnly, removeSelected, undo, redo]
  );

  if (loadError) {
    return (
      <div className="diagram-editor__error" role="alert">
        <p>{loadError}</p>
        <a href="/app">Back to dashboard</a>
      </div>
    );
  }

  if (!diagramLoaded) {
    return <p className="diagram-editor__loading">Loading diagram…</p>;
  }

  return (
    // `role="application"` tells assistive technology that this region handles its own keys, which
    // is exactly true here: Delete, Ctrl+Z and Ctrl+Shift+Z mean something inside the canvas that
    // they do not mean on an ordinary page, and a screen reader needs to stop intercepting them.
    // `tabIndex={0}` is what lets a keyboard user reach that region at all — without it the
    // shortcuts exist and nothing can focus them.
    //
    // Both lint rules below treat a keyboard handler on a non-interactive element as a mistake,
    // because it usually is. Their allowlists do not include `application`, which is the one role
    // whose entire purpose is handling its own keys; moving the handler to a button or a link, as
    // they suggest, would mean a canvas that cannot be typed into. The behaviour is covered by the
    // keyboard cases in `tests/client/DiagramCanvas.test.tsx`.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={`diagram-editor${printMode ? ' diagram-editor--print' : ''}`}
      role="application"
      aria-label="Diagram editor"
      onKeyDown={onKeyDown}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      {/* The page's heading, visually hidden because the title is already on screen in the
          toolbar as an editable field — which is not a heading, so without this the first heading
          a screen-reader user meets is the palette's "Services" and the diagram they opened is
          never announced at all. */}
      <h1 className="visually-hidden">{title} — Diagram editor</h1>
      {/* Print mode strips the editor down to the diagram itself: the toolbar, the panels, the
          status bar, the background grid, the minimap and the canvas controls are all chrome,
          and none of them belongs on paper. */}
      {!printMode && <Toolbar participants={participants} readOnly={readOnly} />}
      <div className="diagram-editor__body">
        {!readOnly && !printMode && paletteOpen && (
          <ServicePalette onAddNode={onAddNodeFromPalette} />
        )}
        <div
          className="diagram-editor__canvas"
          onPointerMove={readOnly ? undefined : onPointerMove}
        >
          {/* Why the canvas just changed. Without this the diagram rewrites itself under the
              visitor with no explanation, which reads as a bug rather than as the feature it is.
              An `<output>`, which carries the `status` role natively, so the notice is announced
              without stealing focus — the change is informational, and taking focus would
              interrupt whatever the visitor was doing. The same element the status bar uses, for
              the same reason. Dismissible rather than self-expiring: a notice that vanished on
              its own could be missed entirely by somebody who had looked away. Hidden in print
              mode along with every other piece of editor chrome. */}
          {remoteChange !== null && !printMode && (
            <output className="live-update-toast">
              <span>
                {remoteChange === 'agent' ? 'Updated by an agent' : 'Updated by another editor'}
              </span>
              <button
                type="button"
                className="live-update-toast__dismiss"
                onClick={() => setRemoteChange(null)}
                aria-label="Dismiss update notice"
              >
                ×
              </button>
            </output>
          )}
          {/* The printed page's own title block. The editor shows the title in the toolbar,
              which print mode has just removed, so without this the paper carries a diagram with
              no name on it. Pointer-inert, so it cannot intercept a click on the canvas beneath
              during the moment before the dialog opens. */}
          {printMode && (
            <div className="diagram-editor__print-overlay">
              <div className="diagram-editor__print-title-box">
                <h2 className="diagram-editor__print-title">{title}</h2>
                {description && <p className="diagram-editor__print-description">{description}</p>}
              </div>
            </div>
          )}
          {/* The way out if the browser never fires `afterprint` — a cancelled dialog in some
              browsers, or a printing path that simply does not. Hidden by the stylesheet's own
              `@media print` rule, so it is never on the paper it exists to escape from. */}
          {printMode && (
            <button
              type="button"
              className="diagram-editor__print-exit"
              onClick={() => setPrintMode(false)}
              title="Exit print mode"
              aria-label="Exit print mode"
            >
              ← Back
            </button>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            // The handlers are withheld rather than guarded internally, so React Flow itself stops
            // offering the interaction: with no `onConnect` there is no connection to start, and
            // with no `onDrop` the canvas is not a drop target at all.
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            // Panning and zooming stay live in both postures: moving around a diagram is reading
            // it, not editing it.
            onViewportChange={onViewportChange}
            onDragOver={readOnly ? undefined : onDragOver}
            onDrop={readOnly ? undefined : onDrop}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            snapToGrid
            snapGrid={SNAP_GRID}
            // React Flow's own delete key is turned off because this canvas handles Delete
            // itself, above: leaving both on would delete through two code paths, only one of
            // which records undo history.
            deleteKeyCode={null}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            defaultEdgeOptions={{ type: CF_EDGE_TYPE }}
          >
            {!printMode && <Background variant={BackgroundVariant.Dots} gap={16} size={1} />}
            {!printMode && minimapOpen && (
              <MiniMap
                nodeColor={(node) => {
                  const data = node.data as CFNodeData;
                  const typeDef = NODE_TYPE_MAP.get(data?.typeId);
                  return CATEGORY_COLORS[valueOrDefault(typeDef?.category, 'external')];
                }}
              />
            )}
            {/* `showInteractive` hides React Flow's own lock control, which would otherwise be a
                tab stop offering to unlock a canvas this visitor may not edit. */}
            {!printMode && <Controls showInteractive={!readOnly} />}
            {!printMode && (
              <RemoteCursorsOverlay
                cursors={remoteCursors}
                edges={edges}
                nodes={nodes}
                selections={remoteSelections}
              />
            )}
          </ReactFlow>
        </div>
        {/* The details panel edits the selection, so it is absent rather than disabled — a
            read-only visitor who selects a node has nothing to change about it. */}
        {!readOnly && !printMode && propertiesOpen && (
          <DetailsPanel
            chatTranscript={chatTranscript}
            chatInFlight={chatInFlight}
            onSendChatMessage={sendChatMessage}
            onStopChatTurn={stopChatTurn}
            onNewConversation={clearChatTranscript}
          />
        )}
      </div>
      {!printMode && <StatusBar readOnly={readOnly} />}
    </div>
  );
}
