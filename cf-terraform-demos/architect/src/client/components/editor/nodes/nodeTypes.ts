import { CF_NODE_TYPE } from '../../../../graph-element-types.ts';
import { CFNode } from './CFNode.tsx';

/**
 * React Flow `nodeTypes` registry, mapping the shared `cf-node` type key to {@link CFNode}.
 *
 * Keyed by the shared constant rather than a re-typed literal, so a node persisted by any writer —
 * a blueprint template today, the editor's own store in a later phase — resolves to this renderer.
 * A drifted literal here would render every node with React Flow's unstyled default instead, which
 * looks like a data problem rather than a registry one.
 */
export const nodeTypes = {
  [CF_NODE_TYPE]: CFNode
};
