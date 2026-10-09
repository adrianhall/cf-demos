import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { CFEdgeData, CFNodeData } from '../../src/client/components/editor/types.ts';
import {
  diffGraphOperations,
  type ClientGraph
} from '../../src/client/lib/graph-operation-diff.ts';

/**
 * Builds a node fixture.
 */
function node(id: string, overrides: Partial<Node<CFNodeData>> = {}): Node<CFNodeData> {
  return {
    data: { label: id, typeId: 'worker' },
    id,
    position: { x: 0, y: 0 },
    type: 'cf-node',
    ...overrides
  };
}

/**
 * Builds an edge fixture.
 */
function edge(id: string, overrides: Partial<Edge<CFEdgeData>> = {}): Edge<CFEdgeData> {
  return {
    data: { edgeType: 'data-flow' },
    id,
    source: 'a',
    target: 'b',
    type: 'cf-edge',
    ...overrides
  } as Edge<CFEdgeData>;
}

/**
 * Builds a graph fixture.
 */
function graph(nodes: Node<CFNodeData>[] = [], edges: Edge<CFEdgeData>[] = []): ClientGraph {
  return { edges, nodes };
}

describe('diffGraphOperations', () => {
  it('returns nothing for an unchanged graph', () => {
    const value = graph([node('a')], []);
    expect(diffGraphOperations(value, structuredClone(value))).toEqual([]);
  });

  it('describes a new node completely, including its visual override', () => {
    const added = node('a', {
      data: {
        description: 'The API',
        label: 'Gateway',
        style: { accentColor: '#123456' },
        typeId: 'worker'
      },
      position: { x: 16, y: 32 }
    });

    expect(diffGraphOperations(graph(), graph([added]))).toEqual([
      {
        input: {
          description: 'The API',
          id: 'a',
          label: 'Gateway',
          position: { x: 16, y: 32 },
          style: { accentColor: '#123456' },
          typeId: 'worker'
        },
        kind: 'add_node'
      }
    ]);
  });

  it('describes node data, style and position changes as one patch', () => {
    const before = node('a');
    const after = node('a', {
      data: {
        description: 'Moved',
        label: 'Gateway',
        style: { accentColor: '#abcdef' },
        typeId: 'worker'
      },
      position: { x: 20, y: 40 }
    });

    expect(diffGraphOperations(graph([before]), graph([after]))).toEqual([
      {
        kind: 'update_node',
        nodeId: 'a',
        patch: {
          description: 'Moved',
          label: 'Gateway',
          position: { x: 20, y: 40 },
          style: { accentColor: '#abcdef' }
        }
      }
    ]);
  });

  it('clears optional node fields explicitly when the user removes them', () => {
    const before = node('a', {
      data: {
        description: 'Old',
        label: 'A',
        style: { accentColor: '#abcdef' },
        typeId: 'worker'
      }
    });
    const after = node('a', { data: { label: 'A', typeId: 'worker' } });

    expect(diffGraphOperations(graph([before]), graph([after]))).toEqual([
      { kind: 'update_node', nodeId: 'a', patch: { description: '', style: {} } }
    ]);
  });

  it('preserves the exact handles on a new edge', () => {
    const added = edge('e', {
      data: {
        description: 'Calls',
        edgeType: 'service-binding',
        label: 'binding',
        protocol: 'binding'
      },
      sourceHandle: 'source-right',
      targetHandle: 'target-left'
    });

    expect(diffGraphOperations(graph(), graph([], [added]))).toEqual([
      {
        input: {
          description: 'Calls',
          edgeType: 'service-binding',
          id: 'e',
          label: 'binding',
          protocol: 'binding',
          source: 'a',
          sourceHandle: 'source-right',
          target: 'b',
          targetHandle: 'target-left'
        },
        kind: 'add_edge'
      }
    ]);
  });

  it('describes every editable edge field in one patch', () => {
    const before = edge('e');
    const after = edge('e', {
      data: {
        description: 'Calls',
        edgeType: 'trigger',
        label: 'event',
        protocol: 'queue'
      }
    });

    expect(diffGraphOperations(graph([], [before]), graph([], [after]))).toEqual([
      {
        edgeId: 'e',
        kind: 'update_edge',
        patch: { description: 'Calls', edgeType: 'trigger', label: 'event', protocol: 'queue' }
      }
    ]);
  });

  it('clears optional edge fields explicitly', () => {
    const before = edge('e', {
      data: { description: 'Old', edgeType: 'data-flow', label: 'old', protocol: 'http' }
    });
    const after = edge('e');

    expect(diffGraphOperations(graph([], [before]), graph([], [after]))).toEqual([
      {
        edgeId: 'e',
        kind: 'update_edge',
        patch: { description: '', label: '', protocol: '' }
      }
    ]);
  });

  it('orders removals before additions so every intermediate graph is valid', () => {
    const before = graph(
      [node('old-a'), node('old-b')],
      [edge('old-edge', { source: 'old-a', target: 'old-b' })]
    );
    const after = graph(
      [node('new-a'), node('new-b')],
      [edge('new-edge', { source: 'new-a', target: 'new-b' })]
    );

    expect(diffGraphOperations(before, after).map((operation) => operation.kind)).toEqual([
      'remove_edge',
      'remove_node',
      'remove_node',
      'add_node',
      'add_node',
      'add_edge'
    ]);
  });
});
