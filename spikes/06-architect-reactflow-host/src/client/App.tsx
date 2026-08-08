import {
  addEdge,
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo, useState, type DragEvent } from "react";
import { BindingEdge } from "./edges/BindingEdge";
import { HttpEdge } from "./edges/HttpEdge";
import { ActorNode } from "./nodes/ActorNode";
import { ProductNode } from "./nodes/ProductNode";
import { PALETTE_DATA_TRANSFER_TYPE, Palette, type PaletteDragPayload } from "./Palette";
import { PropertiesPanel } from "./PropertiesPanel";
import "./app.css";
import { catalogProducts, externalActor } from "./catalog";
import type { CFEdge, CFNode } from "./types";

const nodeTypes = { product: ProductNode, actor: ActorNode };
const edgeTypes = { http: HttpEdge, binding: BindingEdge };

/** The probe's initial diagram: five products, one actor, and one edge of each probed type. */
function buildInitialGraph(): { nodes: CFNode[]; edges: CFEdge[] } {
  const nodes: CFNode[] = catalogProducts.map((product, index) => ({
    id: product.id,
    type: "product",
    position: { x: 80 + (index % 3) * 220, y: 80 + Math.floor(index / 3) * 160 },
    data: {
      label: product.name,
      description: `${product.category} product`,
      color: product.color,
      kind: "product",
    },
  }));

  nodes.push({
    id: externalActor.id,
    type: "actor",
    position: { x: 80, y: 400 },
    data: { label: externalActor.name, description: "", kind: "actor" },
  });

  const edges: CFEdge[] = [
    {
      id: "browser-workers",
      source: externalActor.id,
      target: "workers",
      type: "http",
      data: { label: "HTTPS" },
    },
    {
      id: "workers-d1",
      source: "workers",
      target: "d1",
      type: "binding",
      data: { label: "DB binding" },
    },
  ];

  return { nodes, edges };
}

/** The canvas itself — split from {@link App} so it can call `useReactFlow()` inside the provider. */
function Canvas({ readOnly }: { readOnly: boolean }) {
  const initialGraph = useMemo(buildInitialGraph, []);
  const [nodes, setNodes, onNodesChange] = useNodesState<CFNode>(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CFEdge>(initialGraph.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const { screenToFlowPosition } = useReactFlow<CFNode, CFEdge>();

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge<CFEdge>(
          { ...connection, type: "http", data: { label: "HTTPS" } },
          current,
        ),
      );
    },
    [setEdges],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData(PALETTE_DATA_TRANSFER_TYPE);
      if (!raw) {
        return;
      }
      const payload = JSON.parse(raw) as PaletteDragPayload;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = `${payload.kind}-${crypto.randomUUID()}`;
      const newNode: CFNode = {
        id,
        type: payload.kind,
        position,
        data: {
          label: payload.label,
          description: "",
          color: payload.color,
          kind: payload.kind,
        },
      };
      setNodes((current) => [...current, newNode]);
    },
    [screenToFlowPosition, setNodes],
  );

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);

  const handlePropertiesChange = useCallback(
    (patch: Partial<{ label: string; description: string }>) => {
      if (!selectedNodeId) {
        return;
      }
      setNodes((current) =>
        current.map((node) =>
          node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node,
        ),
      );
    },
    [selectedNodeId, setNodes],
  );

  return (
    <div className="canvas-layout">
      <Palette readOnly={readOnly} />
      <div className="canvas-layout__flow" onDragOver={onDragOver} onDrop={onDrop}>
        <ReactFlow<CFNode, CFEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={readOnly ? undefined : onConnect}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          onSelectionChange={({ nodes: selected }) => setSelectedNodeId(selected[0]?.id)}
          fitView
        >
          <Background />
          <Controls showInteractive={!readOnly} />
        </ReactFlow>
      </div>
      <PropertiesPanel node={selectedNode} readOnly={readOnly} onChange={handlePropertiesChange} />
    </div>
  );
}

/**
 * The probe's root component: a toolbar with the read-only toggle plus the React Flow canvas,
 * palette, and properties panel described by docs/09-ARCHITECT.md's Phase 0 probe.
 */
export function App() {
  const [readOnly, setReadOnly] = useState(false);
  const [identity, setIdentity] = useState<string | undefined>(undefined);

  const loadIdentity = useCallback(async () => {
    const response = await fetch("/api/whoami");
    if (!response.ok) {
      setIdentity(`error: ${response.status}`);
      return;
    }
    const body = (await response.json()) as { email: string };
    setIdentity(body.email);
  }, []);

  return (
    <div className="app">
      <header className="app__toolbar">
        <h1>Architect spike — React Flow host</h1>
        <label className="app__readonly-toggle">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(event) => setReadOnly(event.target.checked)}
          />
          Read-only mode
        </label>
        <button type="button" onClick={() => void loadIdentity()}>
          Call /api/whoami
        </button>
        {identity ? <span className="app__identity">{identity}</span> : null}
        <a className="app__logout" href="/cdn-cgi/access/logout">
          Log out
        </a>
      </header>
      <ReactFlowProvider>
        <Canvas readOnly={readOnly} />
      </ReactFlowProvider>
    </div>
  );
}
