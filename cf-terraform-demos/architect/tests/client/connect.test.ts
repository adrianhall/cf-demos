import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import {
  chooseConnectionHandles,
  findDuplicateEdge,
  validateConnection
} from '../../src/client/components/editor/connect.ts';
import type { CFEdgeData, CFNodeData } from '../../src/client/components/editor/types.ts';

/**
 * @file Covers the pure functions behind the **Connect nodes** dialog. They are tested here rather
 *   than only through the dialog because they are the whole of the rule: which handles an edge
 *   attaches to, and whether a proposed connection is allowed at all. A test that drove them
 *   through the modal would need a mounted canvas to assert a decision that involves no DOM.
 */

/**
 * Builds a node fixture at a position with a catalogue type.
 *
 * @param id Node id, also used as its label.
 * @param typeId Catalogue type identifier.
 * @param position Canvas position, which is what the handle choice is derived from.
 * @returns The node.
 */
function node(id: string, typeId: string, position: { x: number; y: number }): Node<CFNodeData> {
  return { data: { label: id, typeId }, id, position } as Node<CFNodeData>;
}

describe('chooseConnectionHandles', () => {
  it('prefers right and left handles when the target is to the right', () => {
    expect(
      chooseConnectionHandles(
        node('a', 'worker', { x: 0, y: 0 }),
        node('b', 'worker', { x: 300, y: 10 })
      )
    ).toEqual({ sourceHandle: 'source-right', targetHandle: 'target-left' });
  });

  it('prefers bottom and top handles when the target is below', () => {
    expect(
      chooseConnectionHandles(
        node('a', 'worker', { x: 0, y: 0 }),
        node('b', 'worker', { x: 10, y: 300 })
      )
    ).toEqual({ sourceHandle: 'source-bottom', targetHandle: 'target-top' });
  });

  // The catalogue declares no `source-left`/`target-right` pair at all, so a target to the left has
  // no direct handle to attach to and falls through to the vertical pair.
  it('falls back to the vertical pair when the target is to the left', () => {
    expect(
      chooseConnectionHandles(
        node('a', 'worker', { x: 300, y: 0 }),
        node('b', 'worker', { x: 0, y: 10 })
      )
    ).toEqual({ sourceHandle: 'source-bottom', targetHandle: 'target-top' });
  });

  it('falls back to the first declared source handle when the preferred one is absent', () => {
    const { sourceHandle } = chooseConnectionHandles(
      node('a', 'client-browser', { x: 0, y: 0 }),
      node('b', 'worker', { x: 10, y: 300 })
    );

    expect(sourceHandle).toBe('source-bottom');
  });

  // `client-browser` declares only source handles: a person's browser is never the target of a
  // connection in this catalogue.
  it('falls back to null when the target type declares no target handle', () => {
    const { targetHandle } = chooseConnectionHandles(
      node('a', 'worker', { x: 0, y: 0 }),
      node('b', 'client-browser', { x: 10, y: 300 })
    );

    expect(targetHandle).toBeNull();
  });

  // A `typeId` comes from persisted data, so it can outlive the catalogue entry that defined it.
  // `null` lets React Flow attach to the node itself rather than failing to render the edge.
  it('falls back to null for both handles when neither type is in the catalogue', () => {
    expect(
      chooseConnectionHandles(
        node('a', 'gone', { x: 0, y: 0 }),
        node('b', 'also-gone', { x: 10, y: 300 })
      )
    ).toEqual({ sourceHandle: null, targetHandle: null });
  });
});

describe('findDuplicateEdge', () => {
  const edges = [
    { data: { edgeType: 'data-flow' } as CFEdgeData, id: 'e1', source: 'a', target: 'b' }
  ];

  it('finds an edge with the same source, target and type', () => {
    expect(findDuplicateEdge(edges, 'a', 'b', 'data-flow')).toBe(edges[0]);
  });

  // Two nodes legitimately carry both a data flow and a trigger between them, which is why the
  // duplicate check includes the type rather than keying on the node pair alone.
  it('does not treat a different edge type between the same nodes as a duplicate', () => {
    expect(findDuplicateEdge(edges, 'a', 'b', 'trigger')).toBeUndefined();
  });

  it('does not match a reversed pair', () => {
    expect(findDuplicateEdge(edges, 'b', 'a', 'data-flow')).toBeUndefined();
  });
});

describe('validateConnection', () => {
  const edges = [
    { data: { edgeType: 'data-flow' } as CFEdgeData, id: 'e1', source: 'a', target: 'b' }
  ];

  it('rejects connecting a node to itself', () => {
    expect(
      validateConnection({ edgeType: 'data-flow', edges: [], sourceId: 'a', targetId: 'a' })
    ).toBe('A node cannot be connected to itself.');
  });

  it('rejects an exact source, target and type duplicate', () => {
    expect(validateConnection({ edgeType: 'data-flow', edges, sourceId: 'a', targetId: 'b' })).toBe(
      'These nodes are already connected with that edge type.'
    );
  });

  it('allows the same pair with a different edge type', () => {
    expect(
      validateConnection({ edgeType: 'trigger', edges, sourceId: 'a', targetId: 'b' })
    ).toBeNull();
  });

  it('allows a connection to a node that is not yet connected', () => {
    expect(
      validateConnection({ edgeType: 'data-flow', edges, sourceId: 'a', targetId: 'c' })
    ).toBeNull();
  });
});
