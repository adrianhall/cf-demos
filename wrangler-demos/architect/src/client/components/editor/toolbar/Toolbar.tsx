import { useReactFlow } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  Layout as LayoutIcon,
  Link2,
  // Aliased like `Layout as LayoutIcon` above -- a bare `Map` import would shadow the global
  // `Map` constructor `../../../lib/auto-layout.ts`'s `computeAutoLayout` constructs.
  Map as MapIcon,
  Maximize,
  MessageSquare,
  RotateCcw,
  RotateCw,
  Share2,
  Sidebar,
  Users,
  ZoomIn,
  ZoomOut,
} from "react-feather";
import {
  computeAutoLayout,
  type LayoutDirection,
} from "../../../lib/auto-layout";
import { DarkModeToggle } from "../../../components/DarkModeToggle";
import type { DiagramLiveSync } from "../../../hooks/useDiagramLiveSync";
import { useDismissableMenu } from "../../../hooks/useDismissableMenu";
import { useDiagramStore } from "../../../stores/diagramStore";
import { CollaboratorsModal } from "./CollaboratorsModal";
import { ConnectNodesModal } from "./ConnectNodesModal";
import { ExportButton } from "./ExportButton";
import { PresenceStack } from "./PresenceStack";
import { PrintButton } from "./PrintButton";
import { ShareModal } from "./ShareModal";

/** Re-exported so `./Toolbar.test.tsx`'s existing `remapEdgeHandles` import path keeps working
 * unchanged -- the function itself moved to `../../../lib/auto-layout.ts` (docs/09D-ARCHITECT-AICHAT.md's
 * Phase 24), since it is tightly coupled to {@link computeAutoLayout} and independently useful to
 * any future caller of that module. */
export { remapEdgeHandles } from "../../../lib/auto-layout";

/**
 * Top toolbar: back-to-dashboard link, editable diagram title, palette/properties/minimap view
 * toggles, undo/redo, zoom controls, an auto-layout button, a keyboard-operable node-connection
 * dialog (`./ConnectNodesModal.tsx`, Bug 8, docs/09-ARCHITECT.md Phase 10), sharing
 * (`./ShareModal.tsx`), export (`./ExportButton.tsx`), print (`./PrintButton.tsx`), and a dark
 * mode toggle (`../../../components/DarkModeToggle.tsx`). Ported from CF-Architect's
 * `src/islands/toolbar/Toolbar.tsx`.
 *
 * ELK (`elkjs`) is dynamically imported only when auto-layout is actually used
 * (docs/09-ARCHITECT.md's catalog table note: this repository's prior Vue attempt measured a
 * ~540 KB gzip cost for the equivalent library bundled eagerly).
 */
export function Toolbar({
  readOnly = false,
  participants,
}: {
  readOnly?: boolean;
  /** Every other identity currently connected to this diagram's live-sync session
   * (`../../../hooks/useDiagramLiveSync.ts`), rendered via `./PresenceStack.tsx`. Omitted (or
   * empty) in read-only mode, which never opens a live-sync connection. */
  participants?: DiagramLiveSync["participants"];
}) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const {
    undo,
    redo,
    undoStack,
    redoStack,
    title,
    setTitle,
    diagramId,
    ownerEmail,
    nodes,
    paletteOpen,
    togglePalette,
    propertiesOpen,
    toggleProperties,
    detailsPanelTab,
    setDetailsPanelTab,
    minimapOpen,
    toggleMinimap,
  } = useDiagramStore();
  const [layouting, setLayouting] = useState(false);
  const [layoutDirection, setLayoutDirection] =
    useState<LayoutDirection>("DOWN");
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const layoutGroupRef = useRef<HTMLDivElement>(null);
  // "Has the AI Assistant toggle already nudged the service palette closed once this session?"
  // A `useRef` rather than the module-level flag docs/09D-ARCHITECT-AICHAT.md's In-Editor Chat
  // section also allows -- a `useRef` resets exactly when this toolbar itself remounts (i.e. a
  // fresh editor session), which is indistinguishable from "a new session" from the user's own
  // point of view, and keeps this behavior trivially resettable between tests (a module-level
  // `let` would leak across every test in `./Toolbar.test.tsx` instead).
  const paletteNudgeShownRef = useRef(false);

  useDismissableMenu(
    layoutMenuOpen,
    layoutGroupRef,
    useCallback(() => setLayoutMenuOpen(false), []),
  );

  /**
   * Delegate to `../../../lib/auto-layout.ts`'s `computeAutoLayout()` for the actual ELK call,
   * then perform this component's own side effects with its result: push undo history once
   * (so the whole re-layout is a single undo step), replace the store's nodes/edges, enqueue one
   * live-sync `update_node` operation per repositioned node, and fit the viewport. Does nothing
   * to the store when `computeAutoLayout()` returns `null` (ELK's own response carried no
   * `children`), matching this function's pre-extraction behavior exactly -- but still fits the
   * view afterward either way, since a user who pressed this button expects *some* visible
   * response.
   */
  const applyAutoLayout = useCallback(
    async (direction: LayoutDirection) => {
      setLayouting(true);
      try {
        const state = useDiagramStore.getState();
        const result = await computeAutoLayout(
          state.nodes,
          state.edges,
          direction,
        );

        if (result !== null) {
          useDiagramStore.getState().pushHistory();
          useDiagramStore.getState().setNodes(result.nodes);
          useDiagramStore.getState().setEdges(result.edges);

          // Auto-layout repositions every node at once via `setNodes()` rather than one call
          // per node, so -- unlike a single drag, which `../../../stores/diagramStore.ts`'s
          // `onNodesChange` already turns into an `update_node` operation per node on its own --
          // this enqueues one `update_node` (position-only patch) operation per repositioned
          // node directly (docs/09C-COLLABORATIVE-EDITING.md's Phase 18 plan), matching how this
          // repositioning looks to another connected viewer even though the MCP
          // `auto_layout_diagram` tool's *own* server-side write uses a single whole-graph
          // `applyWholeGraphReplace()` instead -- the two paths need not produce identical wire
          // messages to produce the same visual result for other viewers.
          for (const node of result.nodes) {
            useDiagramStore.getState().enqueueOperation({
              kind: "update_node",
              nodeId: node.id,
              patch: { position: node.position },
            });
          }
        }

        setTimeout(() => void fitView({ duration: 300 }), 50);
      } finally {
        setLayouting(false);
      }
    },
    [fitView],
  );

  /**
   * Open the details panel's AI Assistant tab (docs/09D-ARCHITECT-AICHAT.md's In-Editor Chat),
   * opening the details panel itself first if it was closed. The first time this is pressed in
   * this toolbar's lifetime, if the service palette is currently open, this also closes it --
   * reclaiming canvas and sidebar width for the wider chat panel, a one-time nudge rather than an
   * enforced state: the palette's own existing toggle (Bug 4) still opens and closes it freely
   * afterward, and this never re-closes it on a later click.
   */
  const onAiAssistantClick = useCallback(() => {
    setDetailsPanelTab("ai-chat");
    if (!useDiagramStore.getState().propertiesOpen) {
      toggleProperties();
    }
    if (!paletteNudgeShownRef.current) {
      paletteNudgeShownRef.current = true;
      if (useDiagramStore.getState().paletteOpen) {
        togglePalette();
      }
    }
  }, [setDetailsPanelTab, toggleProperties, togglePalette]);

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        {/* Bug 6 (docs/09-ARCHITECT.md Phase 7): this was a text "Architect" logo, duplicating
            `AppShellView.tsx`'s own "Architect" header brand whenever both are visible at once
            (the authenticated editor route). Icon-only here removes the duplicate text while
            keeping the same back-to-dashboard link and destination -- see the deferred Bug 23
            in Phase 9 for the fuller fix of merging this toolbar into that header entirely. */}
        <a
          href="/app"
          className="toolbar__button toolbar__logo"
          title="Back to dashboard"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </a>
        {readOnly ? (
          <span className="toolbar__title-readonly">{title}</span>
        ) : (
          <>
            <label className="visually-hidden" htmlFor="diagram-title">
              Diagram title
            </label>
            <input
              id="diagram-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="toolbar__title"
              placeholder="Untitled Diagram"
            />
          </>
        )}
      </div>

      {!readOnly && (
        <div className="toolbar__group">
          {/* Bug 4 (docs/09-ARCHITECT.md Phase 7): toggles for the two collapsible sidebars, plus
              the canvas minimap. `.toolbar__button--flipped` mirrors the same `Sidebar` glyph
              horizontally for the properties panel, since react-feather has no distinct
              left/right sidebar icon. */}
          <button
            type="button"
            onClick={togglePalette}
            className="toolbar__button"
            title="Toggle service palette"
            aria-label="Toggle service palette"
            aria-pressed={paletteOpen}
          >
            <Sidebar size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={toggleProperties}
            className="toolbar__button toolbar__button--flipped"
            title="Toggle properties panel"
            aria-label="Toggle properties panel"
            aria-pressed={propertiesOpen}
          >
            <Sidebar size={18} aria-hidden="true" />
          </button>
          {/* docs/09D-ARCHITECT-AICHAT.md's In-Editor Chat: opens the details panel's AI
              Assistant tab, matching the palette/properties toggle buttons' own convention.
              `aria-pressed` reflects the panel actually being open *and* showing this tab --
              `detailsPanelTab === "ai-chat"` alone would still read "pressed" while the whole
              sidebar is collapsed, which is not what a user pressing this button again to
              re-open it would expect to see. */}
          <button
            type="button"
            onClick={onAiAssistantClick}
            className="toolbar__button"
            title="AI Assistant"
            aria-label="AI Assistant"
            aria-pressed={propertiesOpen && detailsPanelTab === "ai-chat"}
          >
            <MessageSquare size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={toggleMinimap}
            className="toolbar__button"
            title="Toggle minimap"
            aria-label="Toggle minimap"
            aria-pressed={minimapOpen}
          >
            <MapIcon size={18} aria-hidden="true" />
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          {/* Bug 8 (docs/09-ARCHITECT.md Phase 10): the only way to create an edge otherwise is
              dragging between two canvas handles, which has no keyboard/switch-access
              equivalent (WCAG 2.2 SC 2.5.7 / 2.1.1) -- this opens a fully keyboard-operable
              dialog (`./ConnectNodesModal.tsx`) instead. Disabled with fewer than two nodes,
              since there is nothing to connect. */}
          <button
            type="button"
            onClick={() => setConnectOpen(true)}
            disabled={nodes.length < 2}
            className="toolbar__button"
            title="Connect nodes"
            aria-label="Connect nodes"
          >
            <Link2 size={18} aria-hidden="true" />
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          <button
            type="button"
            onClick={undo}
            disabled={undoStack.length === 0}
            className="toolbar__button"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <RotateCcw size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={redoStack.length === 0}
            className="toolbar__button"
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            <RotateCw size={18} aria-hidden="true" />
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          <button
            type="button"
            onClick={() => void zoomIn()}
            className="toolbar__button"
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void zoomOut()}
            className="toolbar__button"
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void fitView({ duration: 300 })}
            className="toolbar__button"
            title="Fit view"
            aria-label="Fit view"
          >
            <Maximize size={18} aria-hidden="true" />
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          <div className="toolbar__layout-group" ref={layoutGroupRef}>
            <button
              type="button"
              onClick={() => void applyAutoLayout(layoutDirection)}
              disabled={layouting}
              className="toolbar__button"
              title={`Auto layout (${layoutDirection === "DOWN" ? "top to bottom" : "left to right"})`}
              aria-label="Auto layout"
            >
              <LayoutIcon size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="toolbar__button toolbar__button--chevron"
              disabled={layouting}
              onClick={() => setLayoutMenuOpen((prev) => !prev)}
              aria-expanded={layoutMenuOpen}
              aria-haspopup="menu"
              aria-label="Choose layout direction"
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {layoutMenuOpen && (
              <div className="toolbar__layout-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="toolbar__layout-option"
                  onClick={() => {
                    setLayoutDirection("DOWN");
                    setLayoutMenuOpen(false);
                    void applyAutoLayout("DOWN");
                  }}
                >
                  ↓ Top to bottom
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="toolbar__layout-option"
                  onClick={() => {
                    setLayoutDirection("RIGHT");
                    setLayoutMenuOpen(false);
                    void applyAutoLayout("RIGHT");
                  }}
                >
                  → Left to right
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Export, print, and dark mode are always available, including in read-only mode -- an
          anonymous share viewer can export or print a diagram it cannot edit
          (docs/09-ARCHITECT.md Phase 5). Share and Manage collaborators are the two controls
          here still gated to a signed-in editor -- an anonymous share viewer can view but never
          manage sharing or collaborators (docs/09C-COLLABORATIVE-EDITING.md's Access Model). */}
      <div className="toolbar__group toolbar__group--end">
        {!readOnly && participants !== undefined && (
          <PresenceStack participants={participants} />
        )}
        {!readOnly && (
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            disabled={diagramId === null}
            className="toolbar__button"
            title="Share diagram"
            aria-label="Share diagram"
          >
            <Share2 size={18} aria-hidden="true" />
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            onClick={() => setCollaboratorsOpen(true)}
            disabled={diagramId === null}
            className="toolbar__button"
            title="Manage collaborators"
            aria-label="Manage collaborators"
          >
            <Users size={18} aria-hidden="true" />
          </button>
        )}
        <ExportButton />
        <PrintButton />
        <DarkModeToggle className="toolbar__button" />
      </div>

      {!readOnly && diagramId !== null && (
        <ShareModal
          diagramId={diagramId}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
        />
      )}
      {!readOnly && diagramId !== null && (
        <CollaboratorsModal
          diagramId={diagramId}
          ownerEmail={ownerEmail}
          open={collaboratorsOpen}
          onClose={() => setCollaboratorsOpen(false)}
        />
      )}
      {!readOnly && (
        <ConnectNodesModal
          open={connectOpen}
          onClose={() => setConnectOpen(false)}
        />
      )}
    </div>
  );
}
