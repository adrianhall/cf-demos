import { describe, expect, it } from 'vitest';
import { EDGE_TYPES, NODE_TYPES } from '../../src/catalog.ts';
import {
  buildCatalogPromptContext,
  buildGraphPromptContext,
  nextGridPosition
} from '../../src/worker/domain/ai/catalog-context.ts';
import type { GraphData } from '../../src/worker/domain/graph.ts';

/**
 * @file Covers the prompt context the chat assistant is given. The assertions here are mostly about
 *   what is **absent**: the digest's value comes from being small enough to rebuild on every round,
 *   so a test that only checked the ids were present would pass just as happily for a version that
 *   serialised the entire catalogue. The id-instruction test is the other half — without that
 *   sentence a model passes labels where ids belong, which is a failure that costs a whole turn and
 *   leaves no trace in any type.
 */

/**
 * An empty canonical graph.
 *
 * @returns A fresh graph, so a test cannot affect another through a shared object.
 */
function emptyGraph(): GraphData {
  return { edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

/**
 * A graph carrying a given number of placeholder nodes.
 *
 * Only `nodes.length` is read by `nextGridPosition`, so each node's own fields are filler.
 *
 * @param count How many nodes the graph should contain.
 * @returns A graph with that many nodes and no edges.
 */
function graphWithNodeCount(count: number): GraphData {
  return {
    edges: [],
    nodes: Array.from({ length: count }, (_, index) => ({ id: `node-${index}` })),
    viewport: { x: 0, y: 0, zoom: 1 }
  };
}

describe('buildCatalogPromptContext', () => {
  it('names every current node type and its label', () => {
    const context = buildCatalogPromptContext();

    for (const node of NODE_TYPES) {
      expect(context).toContain(node.typeId);
      expect(context).toContain(node.label);
    }
  });

  it('names every current edge type and its label', () => {
    const context = buildCatalogPromptContext();

    for (const edge of EDGE_TYPES) {
      expect(context).toContain(edge.edgeType);
      expect(context).toContain(edge.label);
    }
  });

  it('omits the presentation and scaffold fields a tool call cannot use', () => {
    const context = buildCatalogPromptContext();

    // Icon kinds, handle ids and scaffold binding names: all real fields on the catalog types,
    // none of which can change which typeId or edgeType a call should name.
    expect(context).not.toContain('feather');
    expect(context).not.toContain('target-top');
    expect(context).not.toContain('wranglerBinding');
    expect(context).not.toContain('docLinks');
  });

  it('stays small enough to rebuild into every round of a turn', () => {
    // A generous ceiling rather than an exact byte count: the point is that the digest is a
    // fraction of what re-serialising every field would produce, not that a description's
    // wording is frozen.
    expect(buildCatalogPromptContext().length).toBeLessThan(10_000);
  });

  it('is rebuilt rather than cached, and is stable between calls', () => {
    expect(buildCatalogPromptContext()).toBe(buildCatalogPromptContext());
  });
});

describe('buildGraphPromptContext', () => {
  it('says the canvas is empty rather than omitting the section', () => {
    expect(buildGraphPromptContext(emptyGraph())).toContain('The canvas is empty.');
  });

  it('lists every node id, typeId and label, and every edge id, endpoint and edgeType', () => {
    const context = buildGraphPromptContext({
      edges: [
        {
          data: { edgeType: 'data-flow' },
          id: 'edge-1',
          source: 'node-1',
          target: 'node-2',
          type: 'cf-edge'
        }
      ],
      nodes: [
        { data: { label: 'Gateway', typeId: 'worker' }, id: 'node-1', type: 'cf-node' },
        { data: { label: 'World DB', typeId: 'd1' }, id: 'node-2', type: 'cf-node' }
      ],
      viewport: { x: 0, y: 0, zoom: 1 }
    });

    expect(context).toContain('- id: node-1 | typeId: worker | label: Gateway');
    expect(context).toContain('- id: node-2 | typeId: d1 | label: World DB');
    expect(context).toContain(
      '- id: edge-1 | source: node-1 | target: node-2 | edgeType: data-flow'
    );
  });

  it('tells the model to use ids rather than labels', () => {
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [{ data: { label: 'A', typeId: 'worker' }, id: 'node-1', type: 'cf-node' }],
      viewport: { x: 0, y: 0, zoom: 1 }
    });

    // Not cosmetic: without it a model passes a node's label as an edge endpoint and every
    // add_edge is refused, burning the whole round budget.
    expect(context).toContain('never a label');
  });

  it('names the absent side when a graph has nodes but no edges', () => {
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [{ data: { label: 'A', typeId: 'worker' }, id: 'node-1', type: 'cf-node' }],
      viewport: { x: 0, y: 0, zoom: 1 }
    });

    expect(context).toContain('(no edges)');
    expect(context).not.toContain('(no nodes)');
  });

  it('names the absent side when a graph has edges but no nodes', () => {
    const context = buildGraphPromptContext({
      edges: [
        {
          data: { edgeType: 'data-flow' },
          id: 'edge-1',
          source: 'gone-1',
          target: 'gone-2',
          type: 'cf-edge'
        }
      ],
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 }
    });

    expect(context).toContain('(no nodes)');
    expect(context).not.toContain('(no edges)');
  });

  it('omits positions and descriptions, which cannot change which id a call names', () => {
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [
        {
          data: {
            description: 'A long description the model does not need.',
            label: 'A',
            typeId: 'worker'
          },
          id: 'node-1',
          position: { x: 1234, y: 5678 },
          type: 'cf-node'
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 }
    });

    expect(context).not.toContain('1234');
    expect(context).not.toContain('does not need');
  });

  it('degrades a non-string data field to an empty string', () => {
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [{ data: { label: 42, typeId: null }, id: 'node-1' }],
      viewport: { x: 0, y: 0, zoom: 1 }
    });

    expect(context).toContain('- id: node-1 | typeId:  | label: ');
  });

  it('never prints "undefined" for a malformed record', () => {
    // A graph that reached storage before a field existed, or one assembled in a test: either
    // way, "undefined" in a prompt reads to a model as a value it could pass back.
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [{ data: null, id: 42 }],
      viewport: { x: 0, y: 0, zoom: 1 }
    });

    expect(context).not.toContain('undefined');
    expect(context).toContain('- id:  | typeId:  | label: ');
  });
});

describe('nextGridPosition', () => {
  it('places the first node at the origin', () => {
    expect(nextGridPosition(emptyGraph())).toEqual({ x: 0, y: 0 });
  });

  it('gives a distinct cell to each successive node count', () => {
    const positions = Array.from({ length: 9 }, (_, count) =>
      nextGridPosition(graphWithNodeCount(count))
    );
    const unique = new Set(positions.map((position) => `${position.x},${position.y}`));

    expect(unique.size).toBe(positions.length);
  });

  it('is deterministic for a fixed node count', () => {
    expect(nextGridPosition(graphWithNodeCount(3))).toEqual(
      nextGridPosition(graphWithNodeCount(3))
    );
  });

  it('wraps onto a new row after the configured column count', () => {
    const first = nextGridPosition(graphWithNodeCount(0));
    const wrapped = nextGridPosition(graphWithNodeCount(4));

    expect(wrapped.x).toBe(first.x);
    expect(wrapped.y).toBeGreaterThan(first.y);
  });

  it('staggers across a row before wrapping', () => {
    const second = nextGridPosition(graphWithNodeCount(1));

    expect(second.y).toBe(0);
    expect(second.x).toBeGreaterThan(0);
  });
});
