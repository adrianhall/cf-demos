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
  ZoomIn,
  ZoomOut
} from 'react-feather';
import { useReactFlow } from '@xyflow/react';
import { useDismissableMenu } from '../../../hooks/useDismissableMenu.ts';
import { computeAutoLayout, type LayoutDirection } from '../../../lib/auto-layout.ts';
import { useDiagramStore } from '../../../stores/diagramStore.ts';
import { DarkModeToggle } from '../../DarkModeToggle.tsx';
import { ConnectNodesModal } from './ConnectNodesModal.tsx';
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
  const layoutGroupRef = useRef<HTMLDivElement>(null);

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

      {/* The appearance control is available in both postures: a visitor reading a diagram they
          cannot edit has the same reason to want dark mode as its owner. Sharing is not: an
          anonymous viewer arrived through somebody else's link, and offering them a control to
          mint one of their own would be an offer the server refuses. */}
      <div className="toolbar__group toolbar__group--end">
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
        <DarkModeToggle className="toolbar__button" />
      </div>

      {!readOnly && <ConnectNodesModal open={connectOpen} onClose={() => setConnectOpen(false)} />}
      {/* Mounted only once a diagram is loaded. The modal reads its share status on open, and
          there is no diagram to ask about before then. */}
      {!readOnly && diagramId !== null && (
        <ShareModal diagramId={diagramId} open={shareOpen} onClose={() => setShareOpen(false)} />
      )}
    </div>
  );
}
