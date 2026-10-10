import { useCallback, useMemo, useRef, useState } from "react";
import { EDGE_TYPES, NODE_TYPE_MAP } from "../../../../catalog";
import { useModalFocus } from "../../../hooks/useModalFocus";
import { useDiagramStore } from "../../../stores/diagramStore";
import { validateConnection } from "../connect";
import type { CFEdgeData } from "../types";

/** Human-readable option text for a node: its own label plus its catalog product name, so two
 * nodes with the same user-edited label (e.g. two nodes both renamed "API") are still
 * distinguishable in the source/target dropdowns. */
function nodeOptionLabel(label: string, typeId: string): string {
  const productLabel = NODE_TYPE_MAP.get(typeId)?.label ?? typeId;
  return `${label} (${productLabel})`;
}

/**
 * Toolbar-launched dialog that creates an edge between two nodes chosen from dropdowns, rather
 * than by dragging between their canvas handles. Bug 8 (docs/09-ARCHITECT.md Phase 10): WCAG 2.2
 * SC 2.5.7 (Dragging Movements) and 2.1.1 (Keyboard) both fail for `@xyflow/react`'s
 * pointer-drag-only connection flow (`../DiagramCanvas.tsx`'s `onConnect`), and its own
 * `connectOnClick` default has no keyboard path either -- a `Handle` is an unfocusable `<div>`
 * with no `tabIndex`, role, or accessible name (see `docs/DECISIONS.md`). This dialog is built
 * entirely from this app's own, fully keyboard-operable form controls instead, calling
 * `../../../stores/diagramStore.ts`'s `connectNodes` action to actually create the edge.
 *
 * Mirrors `../blueprints/CreateDiagramModal.tsx`'s modal structure: `useModalFocus()` (Bug 13,
 * docs/09-ARCHITECT.md Phase 7) for initial focus, Tab-trapping, `Escape`-to-close, and focus
 * restoration on close.
 *
 * @param open Whether the modal is visible.
 * @param onClose Called when the modal is dismissed, including after a successful connection.
 */
export function ConnectNodesModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { nodes, edges, selectedNodeId, connectNodes } = useDiagramStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onClose);

  const defaultSource =
    (selectedNodeId && nodes.some((n) => n.id === selectedNodeId)
      ? selectedNodeId
      : nodes[0]?.id) ?? "";
  const defaultTarget =
    nodes.find((n) => n.id !== defaultSource)?.id ?? defaultSource;

  const [sourceId, setSourceId] = useState(defaultSource);
  const [targetId, setTargetId] = useState(defaultTarget);
  const [edgeType, setEdgeType] = useState<CFEdgeData["edgeType"]>("data-flow");

  const invalidReason = useMemo(
    () => validateConnection({ edgeType, edges, sourceId, targetId }),
    [edgeType, edges, sourceId, targetId],
  );

  const handleConnect = useCallback(() => {
    // Defense in depth: the Connect button below is already `disabled` whenever
    // `invalidReason` is set, and a disabled native `<button>` never dispatches a `click` event
    // at all (by the HTML spec), so this is unreachable through the rendered UI -- kept in case
    // a future caller ever invokes `handleConnect` some other way.
    /* istanbul ignore next */
    if (invalidReason) return;
    connectNodes(sourceId, targetId, edgeType);
    onClose();
  }, [connectNodes, edgeType, invalidReason, onClose, sourceId, targetId]);

  if (!open) return null;

  return (
    <div className="modal-overlay">
      {/* See `../blueprints/CreateDiagramModal.tsx`'s identical backdrop for why this is a real,
          natively keyboard-operable button with `tabIndex={-1}` rather than a click handler on a
          non-interactive `<div>`. */}
      <button
        type="button"
        className="modal-overlay__backdrop"
        aria-label="Close dialog"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-nodes-modal-title"
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
        <h2 id="connect-nodes-modal-title" className="modal__title">
          Connect Nodes
        </h2>
        <p className="modal__text">
          Create a connection between two nodes without dragging on the canvas.
        </p>

        <div className="properties-panel__field">
          <label className="properties-panel__label" htmlFor="connect-source">
            Source
          </label>
          <select
            id="connect-source"
            className="properties-panel__input"
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {nodeOptionLabel(node.data.label, node.data.typeId)}
              </option>
            ))}
          </select>
        </div>

        <div className="properties-panel__field">
          <label className="properties-panel__label" htmlFor="connect-target">
            Target
          </label>
          <select
            id="connect-target"
            className="properties-panel__input"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {nodeOptionLabel(node.data.label, node.data.typeId)}
              </option>
            ))}
          </select>
        </div>

        <div className="properties-panel__field">
          <label
            className="properties-panel__label"
            htmlFor="connect-edge-type"
          >
            Connection type
          </label>
          <select
            id="connect-edge-type"
            className="properties-panel__input"
            value={edgeType}
            onChange={(event) =>
              setEdgeType(event.target.value as CFEdgeData["edgeType"])
            }
          >
            {EDGE_TYPES.map((type) => (
              <option key={type.edgeType} value={type.edgeType}>
                {type.label}
              </option>
            ))}
          </select>
        </div>

        {invalidReason && (
          <p className="connect-nodes-modal__error" role="alert">
            {invalidReason}
          </p>
        )}

        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={handleConnect}
            disabled={invalidReason !== null}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
