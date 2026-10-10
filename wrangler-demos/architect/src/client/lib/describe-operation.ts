/**
 * Turn one {@link GraphOperation} into a short, human-readable narration string for the AI chat
 * panel's transcript (`../components/editor/panels/AiChatPanel.tsx`,
 * docs/09D-ARCHITECT-AICHAT.md's In-Editor Chat: "interleaved with compact 'action' entries
 * driven by incoming `operation_applied` (`origin: 'ai-chat'`) messages ('Added node: Workers',
 * 'Connected Workers → D1 (Binding)')").
 *
 * A pure function, independent of `../hooks/useDiagramLiveSync.ts`'s own WebSocket handling, so
 * it is unit-tested directly against fixture nodes/edges with no socket involved.
 *
 * Every lookup here reads from `nodes`/`edges` as they stood *before* the operation described is
 * applied -- the caller (`../hooks/useDiagramLiveSync.ts`'s `operation_applied` handling) must
 * call this before calling `../stores/diagramStore.ts`'s `applyRemoteOperation()`, since a
 * `remove_node`/`remove_edge` operation's own target is gone from the graph the instant that
 * mutation runs, and this function has no other way to learn what it used to be.
 */
import type { Edge, Node } from "@xyflow/react";
import { EDGE_TYPE_MAP } from "../../catalog";
import type { GraphOperation } from "../../graph-mutations";
import type { CFEdgeData, CFNodeData } from "../components/editor/types";

/** Look up a node's current display label by id, falling back to a generic placeholder for a
 * stale/unknown id (a node another operation already removed) rather than throwing -- this
 * function must never crash the transcript it narrates. */
function nodeLabel(nodeId: string, nodes: Node<CFNodeData>[]): string {
  return nodes.find((node) => node.id === nodeId)?.data.label ?? "a node";
}

/** Look up a catalog edge type's human-readable label, falling back to the raw `edgeType`
 * string for an unrecognized value. */
function edgeTypeLabel(edgeType: string): string {
  return EDGE_TYPE_MAP.get(edgeType)?.label ?? edgeType;
}

/**
 * Describe one graph operation as a short, one-line string.
 *
 * @param op The operation to describe -- typically an incoming `operation_applied` frame's
 * `op` field, filtered to `origin: "ai-chat"` by the caller.
 * @param nodes The graph's current nodes, from *before* `op` is applied.
 * @param edges The graph's current edges, from *before* `op` is applied -- only read for
 * `update_edge`/`remove_edge`, whose own operation shape carries an `edgeId` but not the
 * endpoints or edge type needed to describe it.
 * @returns A short narration string, e.g. `"Added node: Workers"` or `"Connected Workers → D1
 * (Binding)"`.
 */
export function describeOperation(
  op: GraphOperation,
  nodes: Node<CFNodeData>[],
  edges: Edge<CFEdgeData>[],
): string {
  switch (op.kind) {
    case "add_node":
      return `Added node: ${op.input.label}`;

    case "update_node": {
      const label = op.patch.label ?? nodeLabel(op.nodeId, nodes);
      return `Updated node: ${label}`;
    }

    case "remove_node":
      return `Removed node: ${nodeLabel(op.nodeId, nodes)}`;

    case "add_edge":
      return `Connected ${nodeLabel(op.input.source, nodes)} → ${nodeLabel(
        op.input.target,
        nodes,
      )} (${edgeTypeLabel(op.input.edgeType)})`;

    case "update_edge": {
      const edge = edges.find((candidate) => candidate.id === op.edgeId);
      const edgeType =
        op.patch.edgeType ??
        (edge?.data as CFEdgeData | undefined)?.edgeType ??
        "data-flow";
      if (!edge) {
        return `Updated connection (${edgeTypeLabel(edgeType)})`;
      }
      return `Updated connection: ${nodeLabel(edge.source, nodes)} → ${nodeLabel(
        edge.target,
        nodes,
      )} (${edgeTypeLabel(edgeType)})`;
    }

    case "remove_edge": {
      const edge = edges.find((candidate) => candidate.id === op.edgeId);
      if (!edge) return "Removed connection";
      return `Removed connection: ${nodeLabel(edge.source, nodes)} → ${nodeLabel(
        edge.target,
        nodes,
      )}`;
    }
  }
}
