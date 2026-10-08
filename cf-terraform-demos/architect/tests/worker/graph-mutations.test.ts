import { describe, expect, it } from 'vitest';
import { CF_EDGE_TYPE, CF_NODE_TYPE } from '../../src/graph-element-types.ts';
import {
  addEdge,
  addNode,
  autoLayout,
  removeEdge,
  removeNode,
  updateEdge,
  updateNode
} from '../../src/worker/domain/graph-mutations.ts';
import type { GraphData } from '../../src/worker/domain/graph.ts';
import { expectProblemStatus } from './problem-details.ts';

/**
 * @file Unit coverage for the granular graph vocabulary the MCP tools are built from. Every case
 *   here runs against a fixture graph with no D1, no Worker, no Durable Object and no MCP protocol
 *   — which is the whole reason these functions are pure. The joins they take part in are covered
 *   elsewhere: the ownership rule and the persist-then-notify ordering in
 *   `./diagram-service.test.ts`, and the live push in `../integration/live-sync.test.ts`.
 */

/**
 * Builds a fixture graph with the given nodes and edges.
 *
 * @param nodes Nodes to place on the canvas.
 * @param edges Edges between them.
 * @returns A graph in the canonical shape every stored diagram has.
 */
function graphOf(
  nodes: Record<string, unknown>[] = [],
  edges: Record<string, unknown>[] = []
): GraphData {
  return { edges, nodes, viewport: { x: 10, y: 20, zoom: 1.5 } };
}

/**
 * Builds a fixture node.
 *
 * @param id Node id.
 * @param extra Fields to merge onto the node, for cases about preservation.
 * @returns A node in the shape the editor stores.
 */
function nodeOf(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: { description: '', label: id, typeId: 'worker' },
    id,
    position: { x: 0, y: 0 },
    type: CF_NODE_TYPE,
    ...extra
  };
}

/**
 * Builds a fixture edge.
 *
 * @param id Edge id.
 * @param source Source node id.
 * @param target Target node id.
 * @returns An edge in the shape the editor stores.
 */
function edgeOf(id: string, source: string, target: string): Record<string, unknown> {
  return {
    data: { edgeType: 'data-flow' },
    id,
    source,
    target,
    type: CF_EDGE_TYPE
  };
}

/**
 * Reads one node's position out of a graph.
 *
 * @param graph Graph to read.
 * @param id Node id.
 * @returns That node's position.
 */
function positionOf(graph: GraphData, id: string): { x: number; y: number } {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  return node?.position as { x: number; y: number };
}

describe('addNode', () => {
  it('appends a node carrying the shared canvas type key', () => {
    const result = addNode(graphOf(), {
      label: 'Edge API',
      position: { x: 40, y: 80 },
      typeId: 'worker'
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      data: { description: '', label: 'Edge API', typeId: 'worker' },
      position: { x: 40, y: 80 },
      // Not a re-typed literal. A node stored with any other `type` persists perfectly and then
      // renders as React Flow's unstyled default.
      type: CF_NODE_TYPE
    });
  });

  it('mints an id when the caller supplies none', () => {
    const result = addNode(graphOf(), { label: 'A', position: { x: 0, y: 0 }, typeId: 'd1' });

    expect(result.nodes[0]?.id).toEqual(expect.any(String));
    expect(result.nodes[0]?.id).not.toBe('');
  });

  // The point of accepting an id: an agent can reference the node it just added in its very next
  // `add_edge` call without reading the graph back to discover a minted UUID.
  it('honours a caller-chosen id', () => {
    const result = addNode(graphOf(), {
      id: 'api',
      label: 'A',
      position: { x: 0, y: 0 },
      typeId: 'worker'
    });

    expect(result.nodes[0]?.id).toBe('api');
  });

  it('defaults an omitted description to an empty string rather than leaving it absent', () => {
    const result = addNode(graphOf(), { label: 'A', position: { x: 0, y: 0 }, typeId: 'worker' });

    expect(result.nodes[0]).toMatchObject({ data: { description: '' } });
  });

  it('refuses a duplicate id rather than producing an unaddressable graph', () => {
    expectProblemStatus(
      () =>
        addNode(graphOf([nodeOf('api')]), {
          id: 'api',
          label: 'A',
          position: { x: 0, y: 0 },
          typeId: 'worker'
        }),
      400
    );
  });

  it('does not mutate the graph it was given', () => {
    const original = graphOf();

    addNode(original, { label: 'A', position: { x: 0, y: 0 }, typeId: 'worker' });

    expect(original.nodes).toHaveLength(0);
  });

  it('leaves edges and the viewport alone', () => {
    const original = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('e1', 'a', 'b')]);

    const result = addNode(original, { label: 'C', position: { x: 0, y: 0 }, typeId: 'kv' });

    expect(result.edges).toEqual(original.edges);
    expect(result.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });
});

describe('updateNode', () => {
  it('merges a label without disturbing the rest of the data payload', () => {
    const result = updateNode(graphOf([nodeOf('api')]), 'api', { label: 'Renamed' });

    expect(result.nodes[0]?.data).toEqual({
      description: '',
      label: 'Renamed',
      typeId: 'worker'
    });
  });

  it('merges a description and a position independently', () => {
    const result = updateNode(graphOf([nodeOf('api')]), 'api', {
      description: 'Handles ingress',
      position: { x: 99, y: 11 }
    });

    expect(result.nodes[0]).toMatchObject({
      data: { description: 'Handles ingress', label: 'api' },
      position: { x: 99, y: 11 }
    });
  });

  // The partial-patch contract: renaming a node must not require resending its position.
  it('leaves an omitted field exactly as it was', () => {
    const result = updateNode(graphOf([nodeOf('api')]), 'api', { label: 'Renamed' });

    expect(result.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it('preserves fields the server does not know about', () => {
    const graph = graphOf([nodeOf('api', { measured: { height: 80, width: 200 } })]);

    const result = updateNode(graph, 'api', { label: 'Renamed' });

    expect(result.nodes[0]?.measured).toEqual({ height: 80, width: 200 });
  });

  // Replacing in place rather than appending, so render order does not shift under an edit.
  it('keeps the node at its original position in the array', () => {
    const graph = graphOf([nodeOf('a'), nodeOf('b'), nodeOf('c')]);

    const result = updateNode(graph, 'b', { label: 'Middle' });

    expect(result.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
  });

  it('reports an unknown node as not found', () => {
    expectProblemStatus(() => updateNode(graphOf([nodeOf('api')]), 'ghost', { label: 'x' }), 404);
  });

  it('does not mutate the graph it was given', () => {
    const original = graphOf([nodeOf('api')]);

    updateNode(original, 'api', { label: 'Renamed' });

    expect(original.nodes[0]).toMatchObject({ data: { label: 'api' } });
  });
});

describe('removeNode', () => {
  it('removes the node', () => {
    const result = removeNode(graphOf([nodeOf('a'), nodeOf('b')]), 'a');

    expect(result.nodes.map((node) => node.id)).toEqual(['b']);
  });

  // The cascade is the point. An edge naming a node that no longer exists does not render, and a
  // later export would write a connection to nothing — a silent corruption rather than an error.
  it('cascades to every edge touching it, in either direction', () => {
    const graph = graphOf(
      [nodeOf('a'), nodeOf('b'), nodeOf('c')],
      [edgeOf('in', 'b', 'a'), edgeOf('out', 'a', 'c'), edgeOf('other', 'b', 'c')]
    );

    const result = removeNode(graph, 'a');

    expect(result.edges.map((edge) => edge.id)).toEqual(['other']);
  });

  it('leaves a graph with no edges touching the node untouched', () => {
    const graph = graphOf([nodeOf('a'), nodeOf('b'), nodeOf('c')], [edgeOf('e', 'b', 'c')]);

    const result = removeNode(graph, 'a');

    expect(result.edges).toEqual(graph.edges);
  });

  it('reports an unknown node as not found', () => {
    expectProblemStatus(() => removeNode(graphOf([nodeOf('api')]), 'ghost'), 404);
  });

  it('does not mutate the graph it was given', () => {
    const original = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('e', 'a', 'b')]);

    removeNode(original, 'a');

    expect(original.nodes).toHaveLength(2);
    expect(original.edges).toHaveLength(1);
  });
});

describe('addEdge', () => {
  it('appends an edge carrying the shared canvas type key', () => {
    const result = addEdge(graphOf([nodeOf('a'), nodeOf('b')]), {
      edgeType: 'service-binding',
      source: 'a',
      target: 'b'
    });

    expect(result.edges[0]).toMatchObject({
      data: { edgeType: 'service-binding' },
      source: 'a',
      target: 'b',
      type: CF_EDGE_TYPE
    });
  });

  it('includes only the optional fields the caller supplied', () => {
    const result = addEdge(graphOf([nodeOf('a'), nodeOf('b')]), {
      edgeType: 'data-flow',
      label: 'writes',
      protocol: 'binding',
      source: 'a',
      target: 'b'
    });

    expect(result.edges[0]?.data).toEqual({
      edgeType: 'data-flow',
      label: 'writes',
      protocol: 'binding'
    });
  });

  it('mints an id when the caller supplies none, and honours one when given', () => {
    const base = graphOf([nodeOf('a'), nodeOf('b')]);

    const minted = addEdge(base, { edgeType: 'data-flow', source: 'a', target: 'b' });
    const chosen = addEdge(base, { edgeType: 'data-flow', id: 'link', source: 'a', target: 'b' });

    expect(minted.edges[0]?.id).toEqual(expect.any(String));
    expect(chosen.edges[0]?.id).toBe('link');
  });

  // Validated before anything is built, so a mistyped id is a refusal rather than the dangling
  // edge `removeNode` works to prevent.
  it.each([
    ['source', { edgeType: 'data-flow', source: 'ghost', target: 'b' }],
    ['target', { edgeType: 'data-flow', source: 'a', target: 'ghost' }]
  ])('reports an unknown %s node as not found', (_which, input) => {
    expectProblemStatus(() => addEdge(graphOf([nodeOf('a'), nodeOf('b')]), input), 404);
  });

  it('refuses a duplicate edge id', () => {
    const graph = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('link', 'a', 'b')]);

    expectProblemStatus(
      () => addEdge(graph, { edgeType: 'data-flow', id: 'link', source: 'a', target: 'b' }),
      400
    );
  });

  // Two nodes may legitimately be connected more than once — a binding and a trigger, say — so
  // only the id is checked for uniqueness, not the endpoint pair.
  it('allows a second edge between the same pair of nodes', () => {
    const graph = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('first', 'a', 'b')]);

    const result = addEdge(graph, { edgeType: 'trigger', source: 'a', target: 'b' });

    expect(result.edges).toHaveLength(2);
  });

  it('allows a self-referential edge, which is a valid retry or recursion arrow', () => {
    const result = addEdge(graphOf([nodeOf('a')]), {
      edgeType: 'trigger',
      source: 'a',
      target: 'a'
    });

    expect(result.edges).toHaveLength(1);
  });

  it('does not mutate the graph it was given', () => {
    const original = graphOf([nodeOf('a'), nodeOf('b')]);

    addEdge(original, { edgeType: 'data-flow', source: 'a', target: 'b' });

    expect(original.edges).toHaveLength(0);
  });
});

describe('updateEdge', () => {
  it('merges each field into the edge data payload', () => {
    const graph = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('link', 'a', 'b')]);

    const result = updateEdge(graph, 'link', {
      description: 'Batched',
      edgeType: 'trigger',
      label: 'enqueue',
      protocol: 'ws'
    });

    expect(result.edges[0]?.data).toEqual({
      description: 'Batched',
      edgeType: 'trigger',
      label: 'enqueue',
      protocol: 'ws'
    });
  });

  it('leaves an omitted field exactly as it was', () => {
    const graph = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('link', 'a', 'b')]);

    const result = updateEdge(graph, 'link', { label: 'reads' });

    expect(result.edges[0]?.data).toEqual({ edgeType: 'data-flow', label: 'reads' });
  });

  // Endpoints are not patchable: changing one would quietly make a connection a different
  // connection, so a caller removes the edge and adds the one they want.
  it('never changes the edge endpoints', () => {
    const graph = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('link', 'a', 'b')]);

    const result = updateEdge(graph, 'link', { edgeType: 'external' });

    expect(result.edges[0]).toMatchObject({ source: 'a', target: 'b' });
  });

  it('keeps the edge at its original position in the array', () => {
    const graph = graphOf(
      [nodeOf('a'), nodeOf('b')],
      [edgeOf('one', 'a', 'b'), edgeOf('two', 'a', 'b'), edgeOf('three', 'a', 'b')]
    );

    const result = updateEdge(graph, 'two', { label: 'middle' });

    expect(result.edges.map((edge) => edge.id)).toEqual(['one', 'two', 'three']);
  });

  it('reports an unknown edge as not found', () => {
    expectProblemStatus(() => updateEdge(graphOf(), 'ghost', { label: 'x' }), 404);
  });
});

describe('removeEdge', () => {
  it('removes only that edge', () => {
    const graph = graphOf(
      [nodeOf('a'), nodeOf('b')],
      [edgeOf('one', 'a', 'b'), edgeOf('two', 'b', 'a')]
    );

    const result = removeEdge(graph, 'one');

    expect(result.edges.map((edge) => edge.id)).toEqual(['two']);
  });

  // Deliberately asymmetric with `removeNode`: an edge is a relationship, so deleting it says
  // nothing about whether the things it related should still exist.
  it('leaves both of its nodes in place', () => {
    const graph = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('one', 'a', 'b')]);

    const result = removeEdge(graph, 'one');

    expect(result.nodes.map((node) => node.id)).toEqual(['a', 'b']);
  });

  it('reports an unknown edge as not found', () => {
    expectProblemStatus(() => removeEdge(graphOf(), 'ghost'), 404);
  });

  it('does not mutate the graph it was given', () => {
    const original = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('one', 'a', 'b')]);

    removeEdge(original, 'one');

    expect(original.edges).toHaveLength(1);
  });
});

describe('autoLayout', () => {
  it('leaves an empty graph empty', () => {
    expect(autoLayout(graphOf()).nodes).toEqual([]);
  });

  it('places a node nothing points at on the top row', () => {
    const result = autoLayout(graphOf([nodeOf('a', { position: { x: 500, y: 500 } })]));

    expect(positionOf(result, 'a')).toEqual({ x: 0, y: 0 });
  });

  it('places each node one row below whatever reaches it first', () => {
    const graph = graphOf(
      [nodeOf('a'), nodeOf('b'), nodeOf('c')],
      [edgeOf('ab', 'a', 'b'), edgeOf('bc', 'b', 'c')]
    );

    const result = autoLayout(graph);

    expect(positionOf(result, 'a').y).toBe(0);
    expect(positionOf(result, 'b').y).toBe(160);
    expect(positionOf(result, 'c').y).toBe(320);
  });

  it('spreads siblings across a row', () => {
    const graph = graphOf(
      [nodeOf('root'), nodeOf('left'), nodeOf('right')],
      [edgeOf('l', 'root', 'left'), edgeOf('r', 'root', 'right')]
    );

    const result = autoLayout(graph);

    expect(positionOf(result, 'left')).toEqual({ x: 0, y: 160 });
    expect(positionOf(result, 'right')).toEqual({ x: 260, y: 160 });
  });

  // Shortest distance from a root, not longest: a node reachable by two paths lands on the row
  // the first traversal to reach it assigns.
  it('uses the shortest distance when two paths reach the same node', () => {
    const graph = graphOf(
      [nodeOf('a'), nodeOf('b'), nodeOf('c')],
      [edgeOf('ac', 'a', 'c'), edgeOf('ab', 'a', 'b'), edgeOf('bc', 'b', 'c')]
    );

    const result = autoLayout(graph);

    expect(positionOf(result, 'c').y).toBe(160);
  });

  // A cycle has no root, so nothing seeds the traversal. Those nodes are placed below everything
  // reachable rather than left wherever they happened to be.
  it('appends a cycle below the deepest reachable row', () => {
    const graph = graphOf(
      [nodeOf('root'), nodeOf('cyclic-a'), nodeOf('cyclic-b')],
      [edgeOf('ab', 'cyclic-a', 'cyclic-b'), edgeOf('ba', 'cyclic-b', 'cyclic-a')]
    );

    const result = autoLayout(graph);

    expect(positionOf(result, 'root').y).toBe(0);
    expect(positionOf(result, 'cyclic-a').y).toBe(160);
    expect(positionOf(result, 'cyclic-b').y).toBe(320);
  });

  it('skips a dangling edge rather than failing a cosmetic rearrangement', () => {
    const graph = graphOf([nodeOf('a')], [edgeOf('ghost', 'a', 'missing'), { id: 'partial' }]);

    const result = autoLayout(graph);

    expect(positionOf(result, 'a')).toEqual({ x: 0, y: 0 });
  });

  // Determinism is what makes this testable at all. A layout depending on iteration order could
  // only ever be reviewed by eye.
  it('produces the identical result when run twice', () => {
    const graph = graphOf(
      [nodeOf('a'), nodeOf('b'), nodeOf('c'), nodeOf('d')],
      [edgeOf('ab', 'a', 'b'), edgeOf('ac', 'a', 'c'), edgeOf('cd', 'c', 'd')]
    );

    expect(autoLayout(autoLayout(graph))).toEqual(autoLayout(graph));
  });

  it('changes where things are drawn, not what is connected or where the user is looking', () => {
    const graph = graphOf([nodeOf('a'), nodeOf('b')], [edgeOf('ab', 'a', 'b')]);

    const result = autoLayout(graph);

    expect(result.edges).toEqual(graph.edges);
    expect(result.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });

  it('preserves every other field on a node', () => {
    const graph = graphOf([nodeOf('a', { selected: true })]);

    const result = autoLayout(graph);

    expect(result.nodes[0]).toMatchObject({ data: { label: 'a' }, selected: true });
  });

  it('does not mutate the graph it was given', () => {
    const original = graphOf([nodeOf('a', { position: { x: 500, y: 500 } })]);

    autoLayout(original);

    expect(original.nodes[0]?.position).toEqual({ x: 500, y: 500 });
  });
});
