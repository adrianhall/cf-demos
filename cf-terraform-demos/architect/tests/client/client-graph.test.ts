import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { CFNodeData } from '../../src/client/components/editor/types.ts';
import { applyClientOperation, parseGraphData } from '../../src/client/lib/client-graph.ts';

/**
 * @file Covers the two pure graph helpers the editor canvas and the generation modal share. They
 *   were private to the canvas until a second caller needed them, and these cases are here rather
 *   than in `./DiagramCanvas.test.tsx` for the reason the module comment gives: the interesting
 *   inputs — a truncated graph, an operation that no longer applies — are far easier to state as
 *   fixtures than to contrive through a socket.
 */

/**
 * The viewport a graph with none recorded is shown at.
 */
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

/**
 * Builds a node fixture.
 *
 * @param id Node id, also used as its label.
 * @returns The node.
 */
function node(id: string): Node<CFNodeData> {
  return {
    data: { label: id, typeId: 'worker' },
    id,
    position: { x: 0, y: 0 },
    type: 'cf-node'
  };
}

describe('parseGraphData', () => {
  it('reads a well-formed graph', () => {
    const parsed = parseGraphData(
      JSON.stringify({ edges: [], nodes: [node('a')], viewport: { x: 5, y: 6, zoom: 2 } })
    );

    expect(parsed.nodes.map((entry) => entry.id)).toEqual(['a']);
    expect(parsed.viewport).toEqual({ x: 5, y: 6, zoom: 2 });
  });

  it('defaults each missing field rather than failing', () => {
    expect(parseGraphData('{}')).toEqual({ edges: [], nodes: [], viewport: DEFAULT_VIEWPORT });
  });

  // An editor that refuses to open leaves the visitor with no way to repair the diagram, where an
  // empty canvas they can rebuild and save over is recoverable.
  it.each([
    ['an empty string', ''],
    ['truncated JSON', '{"nodes": ['],
    ['prose', 'not a graph at all']
  ])('yields an empty canvas for %s', (_label, graphData) => {
    expect(parseGraphData(graphData)).toEqual({
      edges: [],
      nodes: [],
      viewport: DEFAULT_VIEWPORT
    });
  });

  // Each call gets its own object, so one caller mutating the viewport it was handed cannot
  // change what the next one is given.
  it('does not share its default viewport between calls', () => {
    const first = parseGraphData('');
    first.viewport.zoom = 4;

    expect(parseGraphData('').viewport.zoom).toBe(1);
  });
});

describe('applyClientOperation', () => {
  it('applies the operation and leaves the input alone', () => {
    const before = { edges: [], nodes: [node('a')] };

    const after = applyClientOperation(
      before,
      {
        input: { id: 'b', label: 'B', position: { x: 10, y: 10 }, typeId: 'worker' },
        kind: 'add_node'
      },
      DEFAULT_VIEWPORT
    );

    expect(after.nodes.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(before.nodes).toHaveLength(1);
  });

  // Divergence is the characteristic failure of operation-based sync, so it has to be loud: a
  // caller that swallowed this would carry on against a graph the server does not have.
  it('throws when the operation names something the graph does not contain', () => {
    expect(() =>
      applyClientOperation(
        { edges: [], nodes: [] },
        { kind: 'remove_node', nodeId: 'ghost' },
        DEFAULT_VIEWPORT
      )
    ).toThrow();
  });
});
