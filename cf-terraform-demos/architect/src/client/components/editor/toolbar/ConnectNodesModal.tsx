import { useCallback, useMemo, useRef, useState } from 'react';
import { EDGE_TYPES, NODE_TYPE_MAP } from '../../../../catalog.ts';
import { useModalFocus } from '../../../hooks/useModalFocus.ts';
import { useDiagramStore } from '../../../stores/diagramStore.ts';
import { validateConnection } from '../connect.ts';
import type { CFEdgeData } from '../types.ts';

/**
 * Builds the option text for a node: its own label, qualified by its product.
 *
 * Two nodes are regularly given the same label — a diagram with two workers both called "API" is
 * ordinary — and a dropdown that listed them identically would make the choice a guess.
 *
 * @param label The node's user-editable label.
 * @param typeId The node's catalogue type.
 * @returns Text such as `API (Workers)`, falling back to the raw type when the catalogue no longer
 *   defines it.
 */
function nodeOptionLabel(label: string, typeId: string): string {
  return `${label} (${NODE_TYPE_MAP.get(typeId)?.label ?? typeId})`;
}

/**
 * Props for {@link ConnectNodesModal}.
 */
export interface ConnectNodesModalProps {
  /**
   * Whether the dialog is visible.
   */
  open: boolean;
  /**
   * Called when the dialog is dismissed, including after a connection has been made. Shared by
   * Cancel, the close control, the backdrop and Escape, so there is one close path rather than
   * four.
   */
  onClose: () => void;
}

/**
 * The keyboard path to creating a connection.
 *
 * React Flow creates edges by dragging between two handles, and a handle is an unfocusable `<div>`
 * with no role or accessible name — so without this dialog, connecting two services would be
 * possible with a mouse and in no other way, failing WCAG 2.2 SC 2.5.7 and 2.1.1. This is built
 * from ordinary form controls instead, which are keyboard- and switch-operable for free.
 *
 * It is not a lesser alternative path: it is the only one that states the edge type explicitly, so
 * it is frequently the faster way to work even with a pointer.
 *
 * Focus handling matches every other modal in the application through `useModalFocus`.
 *
 * @param props Visibility and close handler; see {@link ConnectNodesModalProps}.
 * @returns The dialog, or `null` while closed.
 */
export function ConnectNodesModal({ open, onClose }: ConnectNodesModalProps) {
  const { nodes, edges, selectedNodeId, connectNodes } = useDiagramStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onClose);

  // Seeded from the selection, because a visitor who selected a node and then opened this dialog
  // has already said what they want to connect from.
  const defaultSource =
    (selectedNodeId && nodes.some((node) => node.id === selectedNodeId)
      ? selectedNodeId
      : nodes[0]?.id) ?? '';
  const defaultTarget = nodes.find((node) => node.id !== defaultSource)?.id ?? defaultSource;

  const [sourceId, setSourceId] = useState(defaultSource);
  const [targetId, setTargetId] = useState(defaultTarget);
  const [edgeType, setEdgeType] = useState<CFEdgeData['edgeType']>('data-flow');

  // Recomputed as the selection changes rather than on submission, so an invalid combination
  // explains itself while the visitor is still choosing instead of failing after they commit.
  const invalidReason = useMemo(
    () => validateConnection({ edgeType, edges, sourceId, targetId }),
    [edgeType, edges, sourceId, targetId]
  );

  const handleConnect = useCallback(() => {
    connectNodes(sourceId, targetId, edgeType);
    onClose();
  }, [connectNodes, edgeType, onClose, sourceId, targetId]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay">
      {/* A real button behind the dialog rather than a click handler on a div, with
          `tabIndex={-1}` to keep it out of the tab order — see `useModalFocus.ts`. */}
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
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-nodes-modal-title"
        tabIndex={-1}
      >
        <button className="modal__close" onClick={onClose} aria-label="Close" type="button">
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
          <label className="properties-panel__label" htmlFor="connect-edge-type">
            Connection type
          </label>
          <select
            id="connect-edge-type"
            className="properties-panel__input"
            value={edgeType}
            onChange={(event) => setEdgeType(event.target.value as CFEdgeData['edgeType'])}
          >
            {EDGE_TYPES.map((type) => (
              <option key={type.edgeType} value={type.edgeType}>
                {type.label}
              </option>
            ))}
          </select>
        </div>

        {/* `role="alert"` rather than silent text: the message appears in response to a choice
            made elsewhere in the form, so a screen-reader user would otherwise discover the
            refusal only by reaching a disabled button with no explanation. */}
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
