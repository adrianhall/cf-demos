import { BookOpen, Video, X } from 'react-feather';
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  type DocLinkIcon,
  EDGE_TYPES,
  NODE_TYPE_MAP
} from '../../../../catalog.ts';
import { useDiagramStore } from '../../../stores/diagramStore.ts';
import type { CFEdgeData, CFNodeData } from '../types.ts';

/**
 * Icon component for each kind of catalogue documentation link.
 */
const DOC_LINK_ICONS: Record<DocLinkIcon, typeof BookOpen> = {
  doc: BookOpen,
  video: Video
};

/**
 * The protocols an edge can be annotated with, beyond "none".
 *
 * A fixed list rather than free text: the value is a hint about the connection, and a dropdown of
 * the transports this platform actually has keeps two diagrams describing the same thing the same
 * way.
 */
const EDGE_PROTOCOLS: { value: string; label: string }[] = [
  { label: 'HTTP', value: 'http' },
  { label: 'WebSocket', value: 'ws' },
  { label: 'Binding', value: 'binding' },
  { label: 'Queue', value: 'queue' },
  { label: 'Email', value: 'email' }
];

/**
 * The panel's close control, shown in every one of its states.
 *
 * Toggling is safe rather than sloppy here: this component is only ever rendered while the panel is
 * open, so the toggle can only ever close it.
 *
 * @returns The close button.
 */
function CloseButton() {
  const toggleProperties = useDiagramStore((state) => state.toggleProperties);

  return (
    <button
      type="button"
      className="properties-panel__close"
      onClick={toggleProperties}
      aria-label="Close properties panel"
      title="Close"
    >
      <X size={16} aria-hidden="true" />
    </button>
  );
}

/**
 * Props for {@link NodeProperties}.
 */
interface NodePropertiesProps {
  /**
   * Id of the node being edited.
   */
  nodeId: string;
  /**
   * The node's current data payload.
   */
  data: CFNodeData;
}

/**
 * The editable properties of one node: its label, annotation, accent colour and documentation.
 *
 * @param props Node id and data; see {@link NodePropertiesProps}.
 * @returns The node's properties.
 */
function NodeProperties({ nodeId, data }: NodePropertiesProps) {
  const updateNodeData = useDiagramStore((state) => state.updateNodeData);
  const typeDef = NODE_TYPE_MAP.get(data.typeId);
  const category = typeDef?.category ?? 'external';

  return (
    <aside className="properties-panel" aria-label="Node properties">
      <CloseButton />
      <h3 className="properties-panel__title">Node Properties</h3>

      <dl className="properties-panel__facts">
        <div className="properties-panel__fact">
          <dt>Type</dt>
          {/* The raw `typeId` when the catalogue no longer defines it, rather than nothing: a
              diagram outlives a renamed product, and the stored identifier is still the honest
              answer to what this node is. */}
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
          onChange={(event) => updateNodeData(nodeId, { label: event.target.value })}
          className="properties-panel__input"
        />
      </div>

      <div className="properties-panel__field">
        <label className="properties-panel__label" htmlFor="node-description">
          Description
        </label>
        <textarea
          id="node-description"
          value={data.description ?? ''}
          onChange={(event) => updateNodeData(nodeId, { description: event.target.value })}
          className="properties-panel__input properties-panel__textarea"
          rows={3}
        />
      </div>

      <div className="properties-panel__field">
        <label className="properties-panel__label" htmlFor="node-accent-color">
          Accent Color
        </label>
        {/* Defaults to the category colour, which is what the node is already painted with. A
            colour input given a value it cannot parse silently shows black instead, so the
            fallback has to be a real colour rather than an empty-ish placeholder. */}
        <input
          id="node-accent-color"
          type="color"
          value={data.style?.accentColor ?? CATEGORY_COLORS[category]}
          onChange={(event) =>
            updateNodeData(nodeId, {
              style: { ...data.style, accentColor: event.target.value }
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
                    <Icon className="properties-panel__doc-icon" size={16} aria-hidden="true" />
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

/**
 * Props for {@link EdgeProperties}.
 */
interface EdgePropertiesProps {
  /**
   * Id of the edge being edited.
   */
  edgeId: string;
  /**
   * The edge's current data payload.
   */
  data: CFEdgeData;
}

/**
 * The editable properties of one edge: its type, label, protocol and annotation.
 *
 * @param props Edge id and data; see {@link EdgePropertiesProps}.
 * @returns The edge's properties.
 */
function EdgeProperties({ edgeId, data }: EdgePropertiesProps) {
  const updateEdgeData = useDiagramStore((state) => state.updateEdgeData);

  return (
    <aside className="properties-panel" aria-label="Edge properties">
      <CloseButton />
      <h3 className="properties-panel__title">Edge Properties</h3>

      <div className="properties-panel__field">
        <label className="properties-panel__label" htmlFor="edge-type">
          Edge Type
        </label>
        <select
          id="edge-type"
          value={data.edgeType}
          onChange={(event) =>
            updateEdgeData(edgeId, {
              edgeType: event.target.value as CFEdgeData['edgeType']
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
          value={data.label ?? ''}
          onChange={(event) => updateEdgeData(edgeId, { label: event.target.value })}
          className="properties-panel__input"
        />
      </div>

      <div className="properties-panel__field">
        <label className="properties-panel__label" htmlFor="edge-protocol">
          Protocol
        </label>
        <select
          id="edge-protocol"
          value={data.protocol ?? ''}
          onChange={(event) =>
            // `undefined` rather than an empty string, so choosing "None" removes the field from
            // the stored graph instead of persisting a blank annotation.
            updateEdgeData(edgeId, { protocol: event.target.value || undefined })
          }
          className="properties-panel__input"
        >
          <option value="">None</option>
          {EDGE_PROTOCOLS.map((protocol) => (
            <option key={protocol.value} value={protocol.value}>
              {protocol.label}
            </option>
          ))}
        </select>
      </div>

      <div className="properties-panel__field">
        <label className="properties-panel__label" htmlFor="edge-description">
          Description
        </label>
        <textarea
          id="edge-description"
          value={data.description ?? ''}
          onChange={(event) => updateEdgeData(edgeId, { description: event.target.value })}
          className="properties-panel__input properties-panel__textarea"
          rows={3}
        />
      </div>
    </aside>
  );
}

/**
 * The editor's details panel content: the properties of whatever is selected.
 *
 * A node takes priority when both ids are somehow set, though the store clears one as it sets the
 * other, so that is a safeguard rather than a reachable state.
 *
 * @returns The selected node's or edge's properties, or an empty state when nothing is selected.
 */
export function PropertiesPanel() {
  const { nodes, edges, selectedNodeId, selectedEdgeId } = useDiagramStore();

  const selectedNode = selectedNodeId
    ? nodes.find((node) => node.id === selectedNodeId)
    : undefined;
  const selectedEdge = selectedEdgeId
    ? edges.find((edge) => edge.id === selectedEdgeId)
    : undefined;

  if (selectedNode) {
    return (
      <NodeProperties nodeId={selectedNode.id} data={selectedNode.data as unknown as CFNodeData} />
    );
  }

  if (selectedEdge) {
    return (
      <EdgeProperties
        edgeId={selectedEdge.id}
        // An edge persisted before the data payload existed still has to render something
        // editable, and a data flow is what an unannotated connection already looks like.
        data={(selectedEdge.data as unknown as CFEdgeData | undefined) ?? { edgeType: 'data-flow' }}
      />
    );
  }

  return (
    <aside className="properties-panel" aria-label="Properties">
      <CloseButton />
      <p className="properties-panel__empty">Select a node or edge to view its properties.</p>
    </aside>
  );
}
