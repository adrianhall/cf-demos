import { describe, expect, it } from 'vitest';
import {
  canonicalizeGraphData,
  EMPTY_GRAPH_DATA,
  type GraphData,
  validateGraphDataInput
} from '../../src/worker/domain/graph.ts';
import { expectProblemStatus } from './problem-details.ts';

/**
 * @file Covers graph validation and canonicalisation. Two properties matter more than the rest and
 *   are asserted directly: a valid node or edge passes through byte-for-byte, because the server
 *   does not know the editor's vocabulary and must not silently drop a field it did not recognise;
 *   and every stored graph has a viewport, so a reader never has to handle its absence.
 */

/**
 * Parses a canonicalised graph for assertion.
 *
 * @param serialised Canonical JSON produced by the functions under test.
 * @returns The decoded graph.
 */
function parse(serialised: string): GraphData {
  return JSON.parse(serialised) as GraphData;
}

describe('canonicalizeGraphData', () => {
  it('defaults missing nodes, edges and viewport', () => {
    expect(parse(canonicalizeGraphData({}))).toEqual({
      edges: [],
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 }
    });
  });

  // The server validates the graph's shape; it does not own the editor's vocabulary. A node
  // arriving with a field this Worker has never heard of must come back out unchanged, or the
  // client would have to wait for a deploy before it could add one.
  it('preserves every node and edge property it does not understand', () => {
    const graph = {
      edges: [{ data: { edgeType: 'data-flow' }, id: 'e1', source: 'a', target: 'b' }],
      nodes: [
        {
          data: { label: 'Workers', somethingNew: true, typeId: 'worker' },
          id: 'a',
          position: { x: 10, y: 20 },
          type: 'cf-node'
        }
      ],
      viewport: { x: 5, y: 6, zoom: 1.5 }
    };

    expect(parse(canonicalizeGraphData(graph))).toEqual(graph);
  });

  it('accepts an explicit viewport unchanged, including a fractional zoom', () => {
    expect(
      parse(canonicalizeGraphData({ viewport: { x: -3, y: 4.5, zoom: 0.75 } })).viewport
    ).toEqual({ x: -3, y: 4.5, zoom: 0.75 });
  });

  it.each([
    ['a non-object graph', 'nope'],
    ['a null graph', null],
    ['an array graph', []],
    ['a nodes value that is not an array', { nodes: 'nope' }],
    ['an edges value that is not an array', { edges: 'nope' }],
    ['a node that is not an object', { nodes: ['not-an-object'] }],
    ['a node with no id', { nodes: [{}] }],
    ['a node with an empty id', { nodes: [{ id: '' }] }],
    ['a node with a non-string id', { nodes: [{ id: 7 }] }],
    ['an edge with no id', { edges: [{ source: 'a', target: 'b' }] }],
    ['a non-object viewport', { viewport: 'nope' }],
    ['a viewport with a non-numeric x', { viewport: { x: '0', y: 0, zoom: 1 } }],
    ['a viewport with a non-numeric y', { viewport: { x: 0, y: '0', zoom: 1 } }],
    ['a viewport with a non-numeric zoom', { viewport: { x: 0, y: 0, zoom: '1' } }]
  ])('rejects %s as unprocessable', (_label, graph) => {
    expectProblemStatus(() => canonicalizeGraphData(graph), 422);
  });

  // A 200-node graph with one bad element needs to say which one, or the only way to find it is
  // bisection.
  it('names the offending element and array in the failure detail', () => {
    expect(() => canonicalizeGraphData({ nodes: [{ id: 'a' }, { id: '' }] })).toThrowError(
      /graphData\.nodes\[1\]/u
    );
  });
});

describe('validateGraphDataInput', () => {
  it('round-trips a well-formed graph through its JSON string field', () => {
    const graphData = JSON.stringify({
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      nodes: [{ data: { typeId: 'worker' }, id: 'a' }, { id: 'b' }],
      viewport: { x: 10, y: 20, zoom: 1.5 }
    });

    expect(parse(validateGraphDataInput({ graphData }))).toEqual({
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      nodes: [{ data: { typeId: 'worker' }, id: 'a' }, { id: 'b' }],
      viewport: { x: 10, y: 20, zoom: 1.5 }
    });
  });

  it.each([
    ['a string body', 'nope'],
    ['a null body', null],
    ['an array body', []]
  ])('rejects %s as a bad request', (_label, body) => {
    expectProblemStatus(() => validateGraphDataInput(body), 400);
  });

  it.each([
    ['an absent graphData field', {}],
    ['a non-string graphData field', { graphData: {} }],
    ['graphData that is not valid JSON', { graphData: '{not json' }],
    ['graphData decoding to an array', { graphData: '[]' }],
    ['graphData decoding to a string', { graphData: '"a string"' }],
    ['graphData decoding to a malformed graph', { graphData: '{"nodes":[{}]}' }]
  ])('rejects %s as unprocessable', (_label, body) => {
    expectProblemStatus(() => validateGraphDataInput(body), 422);
  });
});

describe('EMPTY_GRAPH_DATA', () => {
  // Built through the same canonicaliser every write goes through, so the blank canvas a user
  // starts from is byte-identical to what saving that same empty canvas would produce.
  it('is the canonical form of an empty graph', () => {
    expect(EMPTY_GRAPH_DATA).toBe(canonicalizeGraphData({}));
    expect(parse(EMPTY_GRAPH_DATA)).toEqual({
      edges: [],
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 }
    });
  });
});
