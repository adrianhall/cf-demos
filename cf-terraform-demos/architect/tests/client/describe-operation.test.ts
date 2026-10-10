import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { CFEdgeData, CFNodeData } from '../../src/client/components/editor/types.ts';
import { describeOperation } from '../../src/client/lib/describe-operation.ts';

/**
 * @file Covers the assistant transcript's narration. Every interesting case here is about what the
 *   graph contained _before_ the operation was applied, which is exactly why this is a pure
 *   function tested against fixture arrays rather than a branch inside the canvas's frame handler:
 *   contriving a removed node's former label through a socket would be most of the work and none of
 *   the assertion.
 */

/**
 * Two catalogue-typed nodes, enough for every lookup these cases make.
 */
const nodes: Node<CFNodeData>[] = [
  { data: { label: 'API', typeId: 'worker' }, id: 'a', position: { x: 0, y: 0 } },
  { data: { label: 'Store', typeId: 'd1' }, id: 'b', position: { x: 0, y: 0 } }
];

/**
 * One edge between them.
 */
const edges: Edge<CFEdgeData>[] = [
  { data: { edgeType: 'service-binding' }, id: 'e1', source: 'a', target: 'b' }
];

describe('narrating a node operation', () => {
  it('names an added node from the operation itself', () => {
    expect(
      describeOperation(
        {
          input: { label: 'Cache', position: { x: 0, y: 0 }, typeId: 'kv' },
          kind: 'add_node'
        },
        nodes,
        edges
      )
    ).toBe('Added node: Cache');
  });

  it('prefers a renamed node\u2019s new label over its old one', () => {
    expect(
      describeOperation(
        { kind: 'update_node', nodeId: 'a', patch: { label: 'Gateway' } },
        nodes,
        edges
      )
    ).toBe('Updated node: Gateway');
  });

  it('falls back to the current label when the patch does not rename', () => {
    expect(
      describeOperation(
        { kind: 'update_node', nodeId: 'a', patch: { position: { x: 1, y: 2 } } },
        nodes,
        edges
      )
    ).toBe('Updated node: API');
  });

  // The label is only recoverable from the graph as it stood *before* the removal, which is why
  // the caller must narrate before applying.
  it('names a removed node from the graph it was still in', () => {
    expect(describeOperation({ kind: 'remove_node', nodeId: 'b' }, nodes, edges)).toBe(
      'Removed node: Store'
    );
  });
});

describe('narrating an edge operation', () => {
  it('names both endpoints and the edge type of a new connection', () => {
    expect(
      describeOperation(
        { input: { edgeType: 'service-binding', source: 'a', target: 'b' }, kind: 'add_edge' },
        nodes,
        edges
      )
    ).toBe('Connected API → Store (Service Binding)');
  });

  it('names both endpoints of an updated connection', () => {
    expect(
      describeOperation(
        { edgeId: 'e1', kind: 'update_edge', patch: { edgeType: 'trigger' } },
        nodes,
        edges
      )
    ).toBe('Updated connection: API → Store (Trigger)');
  });

  it('reads an unchanged edge type from the edge itself', () => {
    expect(
      describeOperation(
        { edgeId: 'e1', kind: 'update_edge', patch: { label: 'writes' } },
        nodes,
        edges
      )
    ).toBe('Updated connection: API → Store (Service Binding)');
  });

  it('names a removed connection by its endpoints', () => {
    expect(describeOperation({ edgeId: 'e1', kind: 'remove_edge' }, nodes, edges)).toBe(
      'Removed connection: API → Store'
    );
  });
});

describe('narrating against a graph that has moved on', () => {
  // A narration runs inside the transcript, so an unresolvable reference has to degrade rather
  // than throw — and a racing removal makes that an ordinary event, not a defect.
  it('uses a placeholder for a node that is no longer there', () => {
    expect(describeOperation({ kind: 'remove_node', nodeId: 'gone' }, nodes, edges)).toBe(
      'Removed node: a node'
    );
  });

  it('describes an updated connection it cannot locate', () => {
    expect(
      describeOperation(
        { edgeId: 'gone', kind: 'update_edge', patch: { edgeType: 'trigger' } },
        nodes,
        edges
      )
    ).toBe('Updated connection (Trigger)');
  });

  // With neither the edge nor a patched type there is nothing to name it by, so the default the
  // catalogue itself uses stands in.
  it('falls back to the default edge type for an edge it cannot locate', () => {
    expect(
      describeOperation({ edgeId: 'gone', kind: 'update_edge', patch: {} }, nodes, edges)
    ).toBe('Updated connection (Data Flow)');
  });

  it('describes a removed connection it cannot locate', () => {
    expect(describeOperation({ edgeId: 'gone', kind: 'remove_edge' }, nodes, edges)).toBe(
      'Removed connection'
    );
  });

  // A diagram outlives a renamed edge type, so the stored identifier is shown rather than
  // nothing — the same rule the properties panel applies to a retired product.
  it('shows the raw identifier for an edge type this build does not know', () => {
    expect(
      describeOperation(
        { input: { edgeType: 'no-longer-a-type', source: 'a', target: 'b' }, kind: 'add_edge' },
        nodes,
        edges
      )
    ).toBe('Connected API → Store (no-longer-a-type)');
  });

  it('names an unknown endpoint generically rather than failing', () => {
    expect(
      describeOperation(
        { input: { edgeType: 'data-flow', source: 'gone', target: 'b' }, kind: 'add_edge' },
        nodes,
        edges
      )
    ).toBe('Connected a node → Store (Data Flow)');
  });
});

// Only the MCP tool produces this operation and the assistant never calls it, but the union is
// exhaustiveness-checked: a missing arm here would be a transcript line that silently never
// appeared rather than a build failure.
it('narrates a whole-diagram layout', () => {
  expect(describeOperation({ kind: 'auto_layout' }, nodes, edges)).toBe('Laid out the diagram');
});
