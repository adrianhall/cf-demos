import { CF_EDGE_TYPE } from '../../../../graph-element-types.ts';
import { CFEdge } from './CFEdge.tsx';

/**
 * React Flow `edgeTypes` registry, mapping the shared `cf-edge` type key to {@link CFEdge}.
 *
 * Keyed by the shared constant for the same reason `../nodes/nodeTypes.ts` is: every writer stamps
 * that key, so a re-typed literal here would quietly fall back to React Flow's default edge.
 */
export const edgeTypes = {
  [CF_EDGE_TYPE]: CFEdge
};
