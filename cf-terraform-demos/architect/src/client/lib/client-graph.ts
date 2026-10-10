import type { Edge, Node } from '@xyflow/react';
import type { GraphOperation } from '../../worker/domain/graph-operations.ts';
import { applyGraphOperation } from '../../worker/domain/graph-operations.ts';
import type { CFEdgeData, CFNodeData } from '../components/editor/types.ts';
import type { ClientGraph } from './graph-operation-diff.ts';

/**
 * @file Reading a stored graph, and moving one forward by a confirmed operation. Both began as
 *   private helpers inside `../components/editor/DiagramCanvas.tsx`, which was the only thing that
 *   had ever needed them. The generation modal (`../components/blueprints/GenerateWithAiModal.tsx`)
 *   now needs both as well: it watches the same operation stream over its own short-lived socket
 *   and has to know what the diagram contains before it can lay it out. Neither function belongs to
 *   the canvas any more than it belongs to the modal, so they live here beside
 *   `./graph-operation-diff.ts` — the module that already owns {@link ClientGraph} and the inverse
 *   direction of the same relationship, turning two graphs into the operations between them.
 *   Nothing here knows about React, a store or a socket. That is what lets the interesting cases be
 *   stated against fixture arrays rather than contrived through a connection.
 */

/**
 * A diagram's graph as the client holds it: the two collections plus the stored viewport.
 */
export interface ParsedGraph {
  /**
   * Nodes on the canvas.
   */
  nodes: Node<CFNodeData>[];
  /**
   * Edges on the canvas.
   */
  edges: Edge<CFEdgeData>[];
  /**
   * Stored pan and zoom.
   */
  viewport: { x: number; y: number; zoom: number };
}

/**
 * The viewport a graph with none recorded is shown at.
 */
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

/**
 * Parses a diagram's stored graph.
 *
 * Tolerant on purpose: an empty, truncated or unparseable value yields an empty canvas rather than
 * an exception. The alternative is an editor that refuses to open at all, which leaves the visitor
 * with no way to repair the diagram — whereas an empty canvas they can rebuild and save over is
 * recoverable.
 *
 * @param graphData Stored JSON string.
 * @returns The parsed graph, with every missing field defaulted.
 * @throws Nothing. Every failure mode produces an empty graph instead; see above.
 */
export function parseGraphData(graphData: string): ParsedGraph {
  try {
    const parsed = JSON.parse(graphData || '{}') as Partial<ParsedGraph>;
    return {
      edges: parsed.edges ?? [],
      nodes: parsed.nodes ?? [],
      viewport: parsed.viewport ?? { ...DEFAULT_VIEWPORT }
    };
  } catch {
    return { edges: [], nodes: [], viewport: { ...DEFAULT_VIEWPORT } };
  }
}

/**
 * Applies one shared graph operation to a client graph.
 *
 * The server's own pure function is used rather than reimplemented; this helper only restores the
 * richer React Flow types it cannot know about. It is the building block for optimistic replay in
 * the editor — remote operations applied to the confirmed graph, then pending local operations
 * replayed over it in dispatch order — and the whole of how the generation modal keeps up with a
 * conversation it is watching rather than editing.
 *
 * @param graph Graph to change.
 * @param operation Operation to apply.
 * @param viewport Current viewport, which operations never change but the shared graph shape needs.
 * @returns A new client graph. Neither input is mutated.
 * @throws {ProblemDetailsError} When the operation cannot be applied to this graph, which means the
 *   client has diverged and must request a snapshot.
 */
export function applyClientOperation(
  graph: ClientGraph,
  operation: GraphOperation,
  viewport: ParsedGraph['viewport']
): ClientGraph {
  const next = applyGraphOperation({ edges: graph.edges, nodes: graph.nodes, viewport }, operation);
  return {
    edges: next.edges as Edge<CFEdgeData>[],
    nodes: next.nodes as Node<CFNodeData>[]
  };
}
