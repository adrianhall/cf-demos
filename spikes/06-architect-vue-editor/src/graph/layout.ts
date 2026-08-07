import ELK from "elkjs/lib/elk.bundled.js";
import type { GraphDocument } from "./types";

/** Position graph nodes left-to-right using ELK's layered algorithm. */
export async function layoutGraph(graph: GraphDocument): Promise<GraphDocument> {
  const layout = await new ELK().layout({
    id: "architecture",
    layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "70" },
    children: graph.nodes.map((node) => ({ id: node.id, width: 180, height: 80 })),
    edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  const positions = new Map(layout.children?.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })) };
}
