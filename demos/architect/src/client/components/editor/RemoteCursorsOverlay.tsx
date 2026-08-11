/**
 * Renders every other connected identity's live cursor position and current node selection
 * highlight on top of the canvas (docs/09C-COLLABORATIVE-EDITING.md's Phase 19, the demo's
 * central "each user sees the cursor of the other user" moment, `docs/BACKLOG.md`).
 *
 * Both are rendered inside a `<ViewportPortal>` (`@xyflow/react`) rather than by mutating the
 * store's own `nodes`/`edges` arrays or any node's `className`/`data` -- those arrays are what
 * `../../stores/diagramStore.ts` already serializes verbatim into the `PUT
 * /api/diagrams/:id/graph` fallback payload, so a presence-only annotation added there would
 * risk leaking into persisted `graph_data`. `<ViewportPortal>` renders its children into React
 * Flow's own pan/zoom-transformed viewport element, so a plain flow-space `left`/`top` here
 * tracks the canvas exactly like a real node without touching the graph model at all.
 *
 * `aria-hidden="true"` on the whole overlay: this is a live spatial convenience with no
 * assistive-technology-relevant semantics of its own. A screen reader user already gets the
 * equivalent information (another identity is present and made a change) from
 * `../PresenceStack.tsx`'s named avatars and `./LiveUpdateToast.tsx`'s "Updated by…" toast, not
 * from a moving on-canvas dot -- see AGENTS.md's Browser Applications accessibility bar.
 */
import { useReactFlow, ViewportPortal } from "@xyflow/react";
import { MousePointer } from "react-feather";
import type { DiagramLiveSync } from "../../hooks/useDiagramLiveSync";

/**
 * @param cursors Every other identity's last reported cursor position, keyed by email --
 * `../../hooks/useDiagramLiveSync.ts`'s own `cursors` map.
 * @param remoteSelections Every other identity's current node/edge selection, keyed by email.
 */
export function RemoteCursorsOverlay({
  cursors,
  remoteSelections,
}: {
  cursors: DiagramLiveSync["cursors"];
  remoteSelections: DiagramLiveSync["remoteSelections"];
}) {
  const { getInternalNode } = useReactFlow();

  const cursorEntries = Object.entries(cursors);
  const nodeSelectionEntries = Object.entries(remoteSelections).filter(
    (
      entry,
    ): entry is [string, { nodeId: string; edgeId: null; color: string }] =>
      entry[1].nodeId !== null,
  );

  if (cursorEntries.length === 0 && nodeSelectionEntries.length === 0) {
    return null;
  }

  return (
    <ViewportPortal>
      <div aria-hidden="true">
        {/* An edge selection (`remoteSelections[email].edgeId`) is deliberately not rendered
            here -- this React Flow version's `useReactFlow()` has no edge equivalent of
            `getInternalNode()`'s current-rendered-geometry lookup, so there is no equally
            simple way to draw an accurate outline around an edge's current path the way
            `getInternalNode()` lets this component do for a node. The `remoteSelections` state
            itself still tracks an edge selection (available to a future, more elaborate
            edge-highlight implementation); this phase's Definition of Done only requires
            surfacing "current selection" in general terms, not specifically an edge one, so
            this is a documented, deliberate simplification rather than a gap. */}
        {nodeSelectionEntries.map(([email, selection]) => {
          const node = getInternalNode(selection.nodeId);
          if (node === undefined) return null;
          const { x, y } = node.internals.positionAbsolute;
          const width = node.measured.width ?? 0;
          const height = node.measured.height ?? 0;
          return (
            <div
              key={`selection-${email}`}
              className="remote-selection-highlight"
              style={{
                borderColor: selection.color,
                boxShadow: `0 0 0 2px ${selection.color}`,
                height,
                left: x,
                position: "absolute",
                top: y,
                width,
              }}
            />
          );
        })}
        {cursorEntries.map(([email, cursor]) => (
          <div
            key={`cursor-${email}`}
            className="remote-cursor"
            style={{ left: cursor.x, position: "absolute", top: cursor.y }}
          >
            <MousePointer
              size={16}
              color={cursor.color}
              fill={cursor.color}
              className="remote-cursor__icon"
            />
            <span
              className="remote-cursor__label"
              style={{ backgroundColor: cursor.color }}
            >
              {/* `String.prototype.split()` always returns at least one element, so this is
                  always a `string` (never `undefined`), even for a pathological empty
                  `email`. */}
              {email.split("@")[0]}
            </span>
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}
