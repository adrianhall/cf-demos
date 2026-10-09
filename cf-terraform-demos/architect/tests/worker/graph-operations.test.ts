import { describe, expect, it } from 'vitest';
import {
  applyGraphOperation,
  type GraphOperation
} from '../../src/worker/domain/graph-operations.ts';
import type { GraphData } from '../../src/worker/domain/graph.ts';
import { expectProblemStatus } from './problem-details.ts';

/**
 * @file Covers the operation vocabulary — the data form of a graph change that every write path now
 *   speaks. `./graph-mutations.test.ts` already covers what each underlying function does to a
 *   graph; what matters here is the join: that each operation names the right function, and that
 *   nothing in the union is unreachable. An operation that silently did nothing would be the worst
 *   outcome of this indirection, because a caller would see a successful write that changed
 *   nothing, so every member of the union is exercised.
 */

/**
 * A two-node, one-edge graph to apply operations to.
 *
 * @returns A fresh graph, so a test mutating it cannot affect another.
 */
function graph(): GraphData {
  return {
    edges: [
      { data: { edgeType: 'data-flow' }, id: 'link', source: 'api', target: 'db', type: 'cf-edge' }
    ],
    nodes: [
      { data: { label: 'API' }, id: 'api', position: { x: 10, y: 20 }, type: 'cf-node' },
      { data: { label: 'DB' }, id: 'db', position: { x: 30, y: 40 }, type: 'cf-node' }
    ],
    viewport: { x: 0, y: 0, zoom: 1 }
  };
}

describe('applyGraphOperation', () => {
  it('adds a node', () => {
    const result = applyGraphOperation(graph(), {
      input: { id: 'kv', label: 'Cache', position: { x: 0, y: 99 }, typeId: 'kv' },
      kind: 'add_node'
    });

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[2]).toMatchObject({ data: { label: 'Cache' }, id: 'kv' });
  });

  it('updates a node, leaving the fields it did not name alone', () => {
    const result = applyGraphOperation(graph(), {
      kind: 'update_node',
      nodeId: 'api',
      patch: { label: 'Gateway' }
    });

    expect(result.nodes[0]).toMatchObject({
      data: { label: 'Gateway' },
      position: { x: 10, y: 20 }
    });
  });

  it('removes a node, cascading the edges that touched it', () => {
    const result = applyGraphOperation(graph(), { kind: 'remove_node', nodeId: 'db' });

    expect(result.nodes.map((node) => node.id)).toEqual(['api']);
    expect(result.edges).toEqual([]);
  });

  it('adds an edge', () => {
    const result = applyGraphOperation(graph(), {
      input: { edgeType: 'service-binding', id: 'second', source: 'db', target: 'api' },
      kind: 'add_edge'
    });

    expect(result.edges).toHaveLength(2);
    expect(result.edges[1]).toMatchObject({ id: 'second', source: 'db', target: 'api' });
  });

  it('updates an edge', () => {
    const result = applyGraphOperation(graph(), {
      edgeId: 'link',
      kind: 'update_edge',
      patch: { label: 'reads' }
    });

    expect(result.edges[0]).toMatchObject({ data: { edgeType: 'data-flow', label: 'reads' } });
  });

  it('removes an edge, leaving both of its nodes', () => {
    const result = applyGraphOperation(graph(), { edgeId: 'link', kind: 'remove_edge' });

    expect(result.edges).toEqual([]);
    expect(result.nodes).toHaveLength(2);
  });

  it('lays the graph out, repositioning every node', () => {
    const result = applyGraphOperation(graph(), { kind: 'auto_layout' });

    expect(result.nodes[0]).toMatchObject({ position: { x: 0, y: 0 } });
    expect(result.nodes[1]).toMatchObject({ position: { x: 0, y: 160 } });
  });

  // The operation is a value that crosses an RPC boundary, so it has to survive a structured
  // clone; `JSON` round-tripping is the strictest readily available stand-in for that. An
  // operation that only worked as a live object would fail in production and nowhere else.
  it('applies identically after a serialization round trip, as the RPC boundary requires', () => {
    const operation: GraphOperation = {
      kind: 'update_node',
      nodeId: 'api',
      patch: { position: { x: 7, y: 8 } }
    };

    const direct = applyGraphOperation(graph(), operation);
    const roundTripped = applyGraphOperation(
      graph(),
      JSON.parse(JSON.stringify(operation)) as GraphOperation
    );

    expect(roundTripped).toEqual(direct);
  });

  it('never mutates the graph it was given', () => {
    const original = graph();

    applyGraphOperation(original, { kind: 'remove_node', nodeId: 'api' });

    expect(original.nodes).toHaveLength(2);
  });

  // The refusals the session turns into rejections rather than throwing onward. They carry the
  // status the equivalent REST call answers with, which is what keeps an agent and a browser
  // being told the same thing about the same mistake.
  it.each([
    ['a stale node', { kind: 'remove_node', nodeId: 'ghost' } as const, 404],
    ['a stale node to update', { kind: 'update_node', nodeId: 'ghost', patch: {} } as const, 404],
    ['a stale edge', { edgeId: 'ghost', kind: 'remove_edge' } as const, 404],
    ['a stale edge to update', { edgeId: 'ghost', kind: 'update_edge', patch: {} } as const, 404],
    [
      'an edge to a node that is not there',
      {
        input: { edgeType: 'data-flow', source: 'api', target: 'ghost' },
        kind: 'add_edge'
      } as const,
      404
    ],
    [
      'a duplicate node id',
      {
        input: { id: 'api', label: 'Clash', position: { x: 0, y: 0 }, typeId: 'worker' },
        kind: 'add_node'
      } as const,
      400
    ],
    [
      'a duplicate edge id',
      {
        input: { edgeType: 'data-flow', id: 'link', source: 'api', target: 'db' },
        kind: 'add_edge'
      } as const,
      400
    ]
  ])('refuses %s with %i', (_label, operation, status) => {
    expectProblemStatus(() => applyGraphOperation(graph(), operation), status);
  });
});
