import { useCallback, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  Layout as LayoutIcon,
  Link2,
  // Aliased for the same reason as `LayoutIcon`: a bare `Map` import would shadow the global
  // `Map` constructor that `../../../lib/auto-layout.ts` uses.
  Map as MapIcon,
  Maximize,
  RotateCcw,
  RotateCw,
  Share2,
  Sidebar,
  Users,
  ZoomIn,
  ZoomOut
} from 'react-feather';
import { useReactFlow } from '@xyflow/react';
import { useDismissableMenu } from '../../../hooks/useDismissableMenu.ts';
import { useIdentity } from '../../../hooks/useIdentity.ts';
import { computeAutoLayout, type LayoutDirection } from '../../../lib/auto-layout.ts';
import { useDiagramStore } from '../../../stores/diagramStore.ts';
import { DarkModeToggle } from '../../DarkModeToggle.tsx';
import { CollaboratorsModal } from './CollaboratorsModal.tsx';
import { ConnectNodesModal } from './ConnectNodesModal.tsx';
import { ExportButton } from './ExportButton.tsx';
import { PrintButton } from './PrintButton.tsx';
import { ShareModal } from './ShareModal.tsx';

/**
 * How long the viewport takes to settle after an auto-layout, in milliseconds.
 */
const LAYOUT_FIT_DURATION_MS = 300;

/**
 * How long to wait after replacing the graph before fitting the view, in milliseconds.
 *
 * React Flow measures nodes after it has rendered them, so fitting in the same tick would frame the
 * positions the nodes have just left.
 */
const LAYOUT_FIT_DELAY_MS = 50;

/**
 * Props for {@link Toolbar}.
 */
export interface ToolbarProps {
  /**
   * Whether the canvas is read-only. Every editing control is omitted rather than disabled: a row
   * of permanently dead buttons is a worse answer to "you cannot edit this" than their absence, and
   * a disabled control is still a tab stop that leads nowhere.
   */
  readOnly?: boolean;
}

/**
 * The editor's toolbar: the way back to the dashboard, the diagram's title, and every canvas-wide
 * action.
 *
 * It replaces the common application header on this route rather than sitting under it — the back
 * control already reaches a page that has the header and its sign-out control, so stacking both
 * produced two banners where the upper one offered nothing.
 *
 * ELK is reached through `../../../lib/auto-layout.ts`, which imports it dynamically: the library
 * is far too large to put in the bundle of every visitor who opens a diagram and never presses this
 * button.
 *
 * @param props Read-only flag; see {@link ToolbarProps}.
 * @returns The toolbar.
 */
export function Toolbar({ readOnly = false }: ToolbarProps) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const {
    diagramId,
    role,
    undo,
    redo,
    undoStack,
    redoStack,
    title,
    setTitle,
    nodes,
    paletteOpen,
    togglePalette,
    propertiesOpen,
    toggleProperties,
    minimapOpen,
    toggleMinimap
  } = useDiagramStore();
  const [layouting, setLayouting] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>('DOWN');
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false);
  const layoutGroupRef = useRef<HTMLDivElement>(null);

  // Resolved here rather than passed down, because the collaborators dialog needs to know which
  // row in its list is the visitor's own in order to offer Leave rather than Remove. The share
  // viewer never reaches this: `readOnly` withholds the control that opens the dialog.
  const { email: viewerEmail } = useIdentity();

  /**
   * Whether the visitor owns this diagram, rather than collaborating on it.
   *
   * Gates the three owner-only toolbar affordances — renaming, the anonymous share link, and
   * managing collaborators. Presentational only: each of those endpoints re-derives the rule from
   * the verified Access identity, so a collaborator who recreated the controls by hand would simply
   * collect `404`s. Withholding rather than disabling matches the `readOnly` posture's own
   * reasoning: a permanently dead control is a worse answer than its absence, and it is still a tab
   * stop that leads nowhere.
   */
  const isOwner = role === 'owner';

  useDismissableMenu(
    layoutMenuOpen,
    layoutGroupRef,
    useCallback(() => setLayoutMenuOpen(false), [])
  );

  /**
   * Lays the diagram out and applies the result.
   *
   * The layout itself is computed by `../../../lib/auto-layout.ts`; the side effects are this
   * component's. History is pushed exactly once, so the whole re-layout is a single undo step
   * rather than one per node — a visitor who dislikes the result wants their diagram back, not
   * forty presses of Ctrl+Z.
   *
   * A failure is caught and reported rather than propagated. ELK is loaded on demand, so the
   * realistic failure here is the chunk not arriving at all — an ordinary offline moment, which
   * should leave the diagram untouched and say so, not become an unhandled rejection.
   *
   * @param direction Whether to lay the diagram out downward or to the right.
   * @returns A promise fulfilled once the layout has been applied, or the failure reported.
   */
  const applyAutoLayout = useCallback(
    async (direction: LayoutDirection) => {
      setLayouting(true);
      setLayoutError(null);
      try {
        const state = useDiagramStore.getState();
        const result = await computeAutoLayout(state.nodes, state.edges, direction);

        if (result !== null) {
          useDiagramStore.getState().pushHistory();
          useDiagramStore.getState().setNodes(result.nodes);
          useDiagramStore.getState().setEdges(result.edges);
        }

        // Fitted even when the layout computed nothing: somebody pressed a button, and a control
        // that appears to do nothing at all reads as broken.
        setTimeout(() => void fitView({ duration: LAYOUT_FIT_DURATION_MS }), LAYOUT_FIT_DELAY_MS);
      } catch {
        setLayoutError('Could not lay out this diagram.');
      } finally {
        // In a `finally` so a failed layout re-enables the button rather than leaving the editor
        // with a permanently disabled control and no way to retry.
        setLayouting(false);
      }
    },
    [fitView]
  );

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        {/* Icon-only. A text wordmark here duplicated the one in the application header whenever
            both were visible, and the destination is what matters: this is the way back. */}
        <a
          href="/app"
          className="toolbar__button toolbar__logo"
          title="Back to dashboard"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </a>
        {/* A collaborator sees the title as text, like the share viewer does, because renaming
            is owner-only server-side: an editable field whose every save answered `404` would be
            a worse way to say so than showing the title as what it is. The two postures reach
            the same element for different reasons, which is why the condition names both. */}
        {readOnly || !isOwner ? (
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
        <div className="toolbar__group toolbar__group--editor-controls">
          {/* `aria-pressed` rather than a label that changes between "Show" and "Hide": the state
              belongs in the control's state, not in its name, so a screen reader announces the
              same button whichever way it is currently set. */}
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
          {/* The keyboard path to creating an edge; see `./ConnectNodesModal.tsx`. Disabled below
              two nodes, because there is then nothing a connection could join. */}
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
            onClick={() => void fitView({ duration: LAYOUT_FIT_DURATION_MS })}
            className="toolbar__button"
            title="Fit view"
            aria-label="Fit view"
          >
            <Maximize size={18} aria-hidden="true" />
          </button>
          <span className="toolbar__separator" aria-hidden="true" />
          {/* A split control: the button repeats the last direction, and the chevron chooses a
              new one — so the common case is one press rather than a menu every time. */}
          <div className="toolbar__layout-group" ref={layoutGroupRef}>
            <button
              type="button"
              onClick={() => void applyAutoLayout(layoutDirection)}
              disabled={layouting}
              className="toolbar__button"
              title={`Auto layout (${
                layoutDirection === 'DOWN' ? 'top to bottom' : 'left to right'
              })`}
              aria-label="Auto layout"
            >
              <LayoutIcon size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="toolbar__button toolbar__button--chevron"
              disabled={layouting}
              onClick={() => setLayoutMenuOpen((previous) => !previous)}
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
                    setLayoutDirection('DOWN');
                    setLayoutMenuOpen(false);
                    void applyAutoLayout('DOWN');
                  }}
                >
                  ↓ Top to bottom
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="toolbar__layout-option"
                  onClick={() => {
                    setLayoutDirection('RIGHT');
                    setLayoutMenuOpen(false);
                    void applyAutoLayout('RIGHT');
                  }}
                >
                  → Left to right
                </button>
              </div>
            )}
            {/* Announced, because the press that caused it may have come from the keyboard and
                its only other evidence is a diagram that did not move. */}
            {layoutError && (
              <p className="toolbar__export-error" role="alert">
                {layoutError}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Export, print and the appearance control are available in every posture: a visitor
          reading a diagram they cannot edit has the same reason to want a PNG of it, a printed
          copy, or dark mode as its owner, and none of the three writes anything.

          The two sharing controls are owner-only, and they are two controls rather than one with
          a menu because they do genuinely different things — one mints an anonymous read-only
          link for whoever holds it, the other gives a named, signed-in person write access. A
          single "Share" control covering both would invite the reading that a collaborator is a
          link with a name attached, which is the one misunderstanding worth designing against.
          A collaborator sees neither: both are refused server-side, and an anonymous viewer
          arrived through somebody else's link in the first place. */}
      <div className="toolbar__group toolbar__group--end">
        {!readOnly && isOwner && (
          <>
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
          </>
        )}
        {/* A collaborator gets the collaborator dialog without the share one. They cannot add or
            remove anybody, but they can see who else is editing — and it is the only route to
            leaving a diagram, which has to live somewhere they can reach. */}
        {!readOnly && !isOwner && (
          <button
            type="button"
            onClick={() => setCollaboratorsOpen(true)}
            disabled={diagramId === null}
            className="toolbar__button"
            title="View collaborators"
            aria-label="View collaborators"
          >
            <Users size={18} aria-hidden="true" />
          </button>
        )}
        <ExportButton />
        <PrintButton />
        <DarkModeToggle className="toolbar__button" />
      </div>

      {!readOnly && <ConnectNodesModal open={connectOpen} onClose={() => setConnectOpen(false)} />}
      {/* Both modals are mounted only once a diagram is loaded. Each reads from the server when
          it opens, and there is no diagram to ask about before then. */}
      {!readOnly && isOwner && diagramId !== null && (
        <ShareModal diagramId={diagramId} open={shareOpen} onClose={() => setShareOpen(false)} />
      )}
      {!readOnly && diagramId !== null && (
        <CollaboratorsModal
          diagramId={diagramId}
          viewerRole={role}
          viewerEmail={viewerEmail}
          open={collaboratorsOpen}
          onClose={() => setCollaboratorsOpen(false)}
          // A visitor who has just removed their own access can no longer read this diagram, so
          // the editor it is open in is now showing something the server would refuse to send
          // again. Returning to the dashboard is the honest next screen; staying would leave a
          // canvas whose next autosave answers `404`.
          onLeft={() => {
            window.location.href = '/app';
          }}
        />
      )}
    </div>
  );
}
