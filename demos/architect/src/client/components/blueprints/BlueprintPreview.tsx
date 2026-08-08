import {
  Background,
  BackgroundVariant,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { useMemo } from "react";
import { edgeTypes } from "../editor/edges/edgeTypes";
import { nodeTypes } from "../editor/nodes/nodeTypes";

/** Non-interactive preview of a diagram or blueprint's `graphData`. */
function PreviewInner({
  graphData,
  height = 200,
}: {
  graphData: string;
  height?: number;
}) {
  const { nodes, edges } = useMemo(() => {
    try {
      const parsed = JSON.parse(graphData) as {
        nodes?: Node[];
        edges?: Edge[];
      };
      return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
    } catch {
      return { edges: [] as Edge[], nodes: [] as Node[] };
    }
  }, [graphData]);

  return (
    <div style={{ height, width: "100%" }} aria-hidden="true">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      </ReactFlow>
    </div>
  );
}

/**
 * Read-only, non-interactive React Flow rendering of a diagram's or blueprint's `graphData`,
 * used for the dashboard's diagram cards and the blueprint gallery's template cards. Marked
 * `aria-hidden` -- it is a visual thumbnail only; the surrounding card already carries the
 * diagram/blueprint's accessible name (title). Ported from CF-Architect's
 * `src/islands/blueprints/BlueprintPreview.tsx`.
 *
 * @param graphData JSON-serialised `{ nodes, edges }`. Tolerates malformed input by rendering an
 * empty canvas.
 * @param height Preview height in pixels. Defaults to 200.
 */
export function BlueprintPreview(props: {
  graphData: string;
  height?: number;
}) {
  return (
    <ReactFlowProvider>
      <PreviewInner {...props} />
    </ReactFlowProvider>
  );
}
