import type { ReactNode } from "react";
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  type DocLinkIcon,
  EDGE_TYPES,
  NODE_TYPE_MAP,
} from "../../../../catalog";
import { useDiagramStore } from "../../../stores/diagramStore";
import type { CFEdgeData, CFNodeData } from "../types";

/** Open-book documentation link icon. */
function BookIcon() {
  return (
    <svg
      className="properties-panel__doc-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 2.5A1.5 1.5 0 0 1 3.5 1h2A1.5 1.5 0 0 1 7 2.5V4h2V2.5A1.5 1.5 0 0 1 10.5 1h2A1.5 1.5 0 0 1 14 2.5v10a1.5 1.5 0 0 1-1.5 1.5h-2A1.5 1.5 0 0 1 9 12.5V11H7v1.5A1.5 1.5 0 0 1 5.5 14h-2A1.5 1.5 0 0 1 2 12.5v-10ZM5.5 2.5h-2v10h2v-10Zm5 0v10h2v-10h-2ZM7 5.5v4h2v-4H7Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Video tutorial link icon. */
function VideoIcon() {
  return (
    <svg
      className="properties-panel__doc-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9.5l2.4 1.8A.75.75 0 0 0 14.6 11V5a.75.75 0 0 0-1.2-.6L11 6.2V5a2 2 0 0 0-2-2H3Z"
        fill="currentColor"
      />
    </svg>
  );
}

const DOC_LINK_ICONS: Record<DocLinkIcon, () => ReactNode> = {
  doc: BookIcon,
  video: VideoIcon,
};

/**
 * Right sidebar showing editable properties for the currently selected node or edge: for nodes,
 * type, category, label, description, accent color override, and catalog documentation links;
 * for edges, edge type, label, protocol, and description. Shows an empty-state message when
 * nothing is selected. Ported from CF-Architect's `src/islands/panels/PropertiesPanel.tsx`, with
 * one bug fix: the accent-color `<input type="color">` there computed its `value` as
 * `(data.style?.accentColor ?? typeDef) ? "#" : "#6B7280"` -- since `typeDef` is a truthy object
 * whenever the type is known, that expression evaluated to the literal string `"#"` for every
 * node with no override, an invalid color value silently ignored by the browser. This falls
 * back to the category color instead, matching what the node itself actually renders
 * (`../nodes/CFNode.tsx`).
 */
export function PropertiesPanel() {
  const {
    nodes,
    edges,
    selectedNodeId,
    selectedEdgeId,
    updateNodeData,
    updateEdgeData,
  } = useDiagramStore();

  const selectedNode = selectedNodeId
    ? nodes.find((node) => node.id === selectedNodeId)
    : null;
  const selectedEdge = selectedEdgeId
    ? edges.find((edge) => edge.id === selectedEdgeId)
    : null;

  if (!selectedNode && !selectedEdge) {
    return (
      <aside className="properties-panel" aria-label="Properties">
        <p className="properties-panel__empty">
          Select a node or edge to view its properties.
        </p>
      </aside>
    );
  }

  if (selectedNode) {
    const data = selectedNode.data as unknown as CFNodeData;
    const typeDef = NODE_TYPE_MAP.get(data.typeId);
    const category = typeDef?.category ?? "external";

    return (
      <aside className="properties-panel" aria-label="Node properties">
        <h3 className="properties-panel__title">Node Properties</h3>

        <dl className="properties-panel__facts">
          <div className="properties-panel__fact">
            <dt>Type</dt>
            <dd>{typeDef?.label ?? data.typeId}</dd>
          </div>
          <div className="properties-panel__fact">
            <dt>Category</dt>
            <dd>{CATEGORY_LABELS[category]}</dd>
          </div>
        </dl>

        <div className="properties-panel__field">
          <label className="properties-panel__label" htmlFor="node-label">
            Label
          </label>
          <input
            id="node-label"
            type="text"
            value={data.label}
            onChange={(event) =>
              updateNodeData(selectedNode.id, { label: event.target.value })
            }
            className="properties-panel__input"
          />
        </div>

        <div className="properties-panel__field">
          <label className="properties-panel__label" htmlFor="node-description">
            Description
          </label>
          <textarea
            id="node-description"
            value={data.description ?? ""}
            onChange={(event) =>
              updateNodeData(selectedNode.id, {
                description: event.target.value,
              })
            }
            className="properties-panel__input properties-panel__textarea"
            rows={3}
          />
        </div>

        <div className="properties-panel__field">
          <label
            className="properties-panel__label"
            htmlFor="node-accent-color"
          >
            Accent Color
          </label>
          <input
            id="node-accent-color"
            type="color"
            value={data.style?.accentColor ?? CATEGORY_COLORS[category]}
            onChange={(event) =>
              updateNodeData(selectedNode.id, {
                style: { ...data.style, accentColor: event.target.value },
              })
            }
            className="properties-panel__color"
          />
        </div>

        {typeDef?.docLinks && typeDef.docLinks.length > 0 && (
          <div className="properties-panel__field">
            <span className="properties-panel__label">Documentation</span>
            <ul className="properties-panel__doc-list">
              {typeDef.docLinks.map((link) => {
                const Icon = DOC_LINK_ICONS[link.icon];
                return (
                  <li key={link.url}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="properties-panel__doc-link"
                    >
                      <Icon />
                      <span>{link.title}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </aside>
    );
  }

  if (selectedEdge) {
    const data = (selectedEdge.data as unknown as CFEdgeData) ?? {
      edgeType: "data-flow",
    };

    return (
      <aside className="properties-panel" aria-label="Edge properties">
        <h3 className="properties-panel__title">Edge Properties</h3>

        <div className="properties-panel__field">
          <label className="properties-panel__label" htmlFor="edge-type">
            Edge Type
          </label>
          <select
            id="edge-type"
            value={data.edgeType}
            onChange={(event) =>
              updateEdgeData(selectedEdge.id, {
                edgeType: event.target.value as CFEdgeData["edgeType"],
              })
            }
            className="properties-panel__input"
          >
            {EDGE_TYPES.map((edgeType) => (
              <option key={edgeType.edgeType} value={edgeType.edgeType}>
                {edgeType.label}
              </option>
            ))}
          </select>
        </div>

        <div className="properties-panel__field">
          <label className="properties-panel__label" htmlFor="edge-label">
            Label
          </label>
          <input
            id="edge-label"
            type="text"
            value={data.label ?? ""}
            onChange={(event) =>
              updateEdgeData(selectedEdge.id, { label: event.target.value })
            }
            className="properties-panel__input"
          />
        </div>

        <div className="properties-panel__field">
          <label className="properties-panel__label" htmlFor="edge-protocol">
            Protocol
          </label>
          <select
            id="edge-protocol"
            value={data.protocol ?? ""}
            onChange={(event) =>
              updateEdgeData(selectedEdge.id, {
                protocol: event.target.value || undefined,
              })
            }
            className="properties-panel__input"
          >
            <option value="">None</option>
            <option value="http">HTTP</option>
            <option value="ws">WebSocket</option>
            <option value="binding">Binding</option>
            <option value="queue">Queue</option>
            <option value="email">Email</option>
          </select>
        </div>

        <div className="properties-panel__field">
          <label className="properties-panel__label" htmlFor="edge-description">
            Description
          </label>
          <textarea
            id="edge-description"
            value={data.description ?? ""}
            onChange={(event) =>
              updateEdgeData(selectedEdge.id, {
                description: event.target.value,
              })
            }
            className="properties-panel__input properties-panel__textarea"
            rows={3}
          />
        </div>
      </aside>
    );
  }

  // Unreachable: the empty-state check above already covers "neither selected," so by this
  // point exactly one of `selectedNode`/`selectedEdge` is truthy and one of the two blocks
  // above always returns first. TypeScript's control-flow analysis cannot see that from
  // `selectedNodeId`/`selectedEdgeId` alone, so a function returning JSX still needs this
  // explicit fallback to type-check.
  /* istanbul ignore next */
  return null;
}
