/**
 * Pure helpers backing the "Connect nodes" dialog (`./toolbar/ConnectNodesModal.tsx`), Bug 8's
 * keyboard/non-drag alternative to `@xyflow/react`'s pointer-drag-only edge creation
 * (docs/09-ARCHITECT.md Phase 10; WCAG 2.2 SC 2.5.7 / 2.1.1).
 *
 * Kept independent of Zustand and React so every branch is directly unit-testable without
 * mounting a component or mocking `@xyflow/react` -- `../../stores/diagramStore.ts`'s
 * `connectNodes` action is the only caller, and it is itself covered by its own store-level
 * tests for the state-mutation side of the same feature.
 */
import type { Edge, Node } from "@xyflow/react";
import type { HandleDef } from "../../../catalog";
import { NODE_TYPE_MAP } from "../../../catalog";
import type { CFEdgeData, CFNodeData } from "./types";

/** A resolved source/target handle pair, or `null` where the node type declares no handle of
 * that kind at all -- `@xyflow/react` treats a `null` handle as "connect to the node itself,
 * any handle." */
export interface ConnectionHandles {
  sourceHandle: string | null;
  targetHandle: string | null;
}

/**
 * Resolve one side (source or target) of a connection's handle: the preferred handle id if the
 * node declares it, otherwise the first handle of the right `kind` it does declare, otherwise
 * `null`. Shared by both sides of {@link chooseConnectionHandles} rather than duplicated per
 * side, since the two are otherwise identical apart from which `HandleDef.type` they search for.
 */
function resolveHandle(
  handles: HandleDef[],
  preferredId: string,
  kind: HandleDef["type"],
): string | null {
  if (handles.some((h) => h.id === preferredId)) return preferredId;
  return handles.find((h) => h.type === kind)?.id ?? null;
}

/**
 * Choose which of a source/target node pair's declared handles a dialog-created edge should use,
 * mirroring `./toolbar/Toolbar.tsx`'s `remapEdgeHandles` auto-layout convention: this catalog's
 * `defaultHandles` (`../../../catalog.ts`) only ever declares a `source` handle on the bottom or
 * right of a node and a `target` handle on the top or left, so there is no direct handle for an
 * edge whose target sits above or to the left of its source -- that case, and any node type
 * declaring no handles in the preferred direction at all, falls back to the first handle of the
 * right `type` the node actually declares (`resolveHandle` above), then to `null` (let
 * `@xyflow/react` pick any handle on that node) if it declares none.
 *
 * @param source The connection's source node (must have a real `position`, i.e. already laid out
 * on the canvas -- always true for an existing node passed in from the store).
 * @param target The connection's target node.
 * @returns The resolved `{ sourceHandle, targetHandle }` pair.
 */
export function chooseConnectionHandles(
  source: Node<CFNodeData>,
  target: Node<CFNodeData>,
): ConnectionHandles {
  const dx = target.position.x - source.position.x;
  const dy = target.position.y - source.position.y;
  const preferRight = Math.abs(dx) >= Math.abs(dy) && dx > 0;
  const preferred = preferRight
    ? { source: "source-right", target: "target-left" }
    : { source: "source-bottom", target: "target-top" };

  const sourceHandles =
    NODE_TYPE_MAP.get(source.data.typeId)?.defaultHandles ?? [];
  const targetHandles =
    NODE_TYPE_MAP.get(target.data.typeId)?.defaultHandles ?? [];

  return {
    sourceHandle: resolveHandle(sourceHandles, preferred.source, "source"),
    targetHandle: resolveHandle(targetHandles, preferred.target, "target"),
  };
}

/**
 * Find an existing edge between the same source and target with the same
 * {@link CFEdgeData.edgeType}. A source/target pair connected by two *different* edge types
 * (e.g. a `data-flow` edge and a separate `trigger` edge) is legitimate and is not considered a
 * duplicate.
 */
export function findDuplicateEdge(
  edges: Edge<CFEdgeData>[],
  sourceId: string,
  targetId: string,
  edgeType: CFEdgeData["edgeType"],
): Edge<CFEdgeData> | undefined {
  return edges.find(
    (edge) =>
      edge.source === sourceId &&
      edge.target === targetId &&
      edge.data?.edgeType === edgeType,
  );
}

/** Input to {@link validateConnection}. */
export interface ValidateConnectionInput {
  sourceId: string;
  targetId: string;
  edgeType: CFEdgeData["edgeType"];
  edges: Edge<CFEdgeData>[];
}

/**
 * Validate a proposed dialog-created connection before it is applied to the store.
 *
 * @returns A human-readable reason the connection is invalid, or `null` when it is valid.
 */
export function validateConnection({
  sourceId,
  targetId,
  edgeType,
  edges,
}: ValidateConnectionInput): string | null {
  if (sourceId === targetId) {
    return "A node cannot be connected to itself.";
  }
  if (findDuplicateEdge(edges, sourceId, targetId, edgeType)) {
    return "These nodes are already connected with that edge type.";
  }
  return null;
}
