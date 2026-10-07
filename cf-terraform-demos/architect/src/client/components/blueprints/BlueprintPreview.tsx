import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider
} from '@xyflow/react';
import { edgeTypes } from '../editor/edges/edgeTypes.ts';
import { nodeTypes } from '../editor/nodes/nodeTypes.ts';

/**
 * Props for {@link BlueprintPreview}.
 */
export interface BlueprintPreviewProps {
  /**
   * JSON-serialised `{ nodes, edges }`, from a blueprint template or a stored diagram.
   */
  graphData: string;
  /**
   * Preview height in pixels. Defaults to 200.
   */
  height?: number;
}

/**
 * The preview's canvas, inside the provider {@link BlueprintPreview} supplies.
 *
 * @param props Graph and height; see {@link BlueprintPreviewProps}.
 * @returns The non-interactive canvas.
 */
function PreviewInner({ graphData, height = 200 }: BlueprintPreviewProps) {
  const { nodes, edges } = useMemo(() => {
    try {
      const parsed = JSON.parse(graphData) as { nodes?: Node[]; edges?: Edge[] };
      return { edges: parsed.edges ?? [], nodes: parsed.nodes ?? [] };
    } catch {
      // An empty canvas rather than a thrown error. A thumbnail is decoration: one unreadable
      // graph should cost a visitor that one card, not the whole gallery or dashboard.
      return { edges: [] as Edge[], nodes: [] as Node[] };
    }
  }, [graphData]);

  return (
    <div style={{ height, width: '100%' }} aria-hidden="true">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // React Flow defaults both of these to `true` regardless of `elementsSelectable`, so
        // without them every node and edge in this thumbnail renders `tabIndex={0}`. That is
        // focusable content inside the `aria-hidden` wrapper above (WCAG 4.1.2), and on a dashboard
        // of many diagrams it floods the tab order with stops a screen-reader user can never get
        // any content from.
        nodesFocusable={false}
        edgesFocusable={false}
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
 * A read-only, non-interactive rendering of a diagram's or blueprint's graph.
 *
 * A real React Flow canvas rather than a static image, which is what makes the gallery and the
 * dashboard show the architecture a card actually contains: the thumbnail uses the same node and
 * edge renderers as the editor, so what a visitor sees on the card is what they get when they open
 * it. There is no screenshot to regenerate and no thumbnail column to keep in step.
 *
 * `aria-hidden`, because the surrounding card already carries the diagram's or template's
 * accessible name. A thumbnail that announced itself would make a screen reader read each title
 * twice and then describe a picture of it.
 *
 * @param props Graph and height; see {@link BlueprintPreviewProps}.
 * @returns The preview, wrapped in its own React Flow provider so several can be mounted side by
 *   side without sharing one canvas's state.
 */
export function BlueprintPreview(props: BlueprintPreviewProps) {
  return (
    <ReactFlowProvider>
      <PreviewInner {...props} />
    </ReactFlowProvider>
  );
}
