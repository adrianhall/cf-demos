import { describe, expect, it, vi } from 'vitest';

/**
 * @file Covers auto-layout. ELK itself is replaced with a stub, because what is under test is the
 *   graph description this module builds and the result it maps back onto React Flow's own shape —
 *   not whether a third-party layout engine lays a graph out well. The stub is also how the lazy
 *   import is held to its contract: the module under test is imported after the mock is registered,
 *   exactly as the browser loads ELK only when the button is pressed.
 */

const { mockElkLayout } = vi.hoisted(() => ({ mockElkLayout: vi.fn() }));

vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class MockElk {
    layout = mockElkLayout;
  }
}));

const { computeAutoLayout, remapEdgeHandles } = await import('../../src/client/lib/auto-layout.ts');

/**
 * Two catalogue-typed nodes, enough for every handle lookup these tests make.
 */
const nodes = [
  { data: { label: 'A', typeId: 'worker' }, id: 'a', position: { x: 0, y: 0 } },
  { data: { label: 'B', typeId: 'worker' }, id: 'b', position: { x: 0, y: 0 } }
];

describe('remapEdgeHandles', () => {
  it('remaps to bottom and top handles for a downward layout', () => {
    const [remapped] = remapEdgeHandles([{ id: 'e1', source: 'a', target: 'b' }], nodes, 'DOWN');

    expect(remapped).toMatchObject({ sourceHandle: 'source-bottom', targetHandle: 'target-top' });
  });

  it('remaps to right and left handles for a rightward layout', () => {
    const [remapped] = remapEdgeHandles([{ id: 'e1', source: 'a', target: 'b' }], nodes, 'RIGHT');

    expect(remapped).toMatchObject({ sourceHandle: 'source-right', targetHandle: 'target-left' });
  });

  // Identity, not just equality: a caller doing a shallow comparison can then tell that nothing
  // about this edge changed.
  it('returns the same object when the handles already match', () => {
    const edge = {
      id: 'e1',
      source: 'a',
      sourceHandle: 'source-bottom',
      target: 'b',
      targetHandle: 'target-top'
    };

    expect(remapEdgeHandles([edge], nodes, 'DOWN')[0]).toBe(edge);
  });

  // A node can genuinely carry a type the catalogue does not know: `add_node` stores an unknown
  // `typeId` rather than rejecting it, so that an agent naming a product this build has never
  // heard of draws something instead of failing. Such a node declares no default handles, and the
  // remap has to leave the edge's existing ones alone rather than point it at a handle that will
  // not be rendered — an edge attached to a handle that does not exist disappears from the
  // canvas, which is a worse outcome than a tidier arrow.
  it('leaves handles alone for a node whose type the catalogue does not know', () => {
    const unknown = [
      { data: { label: 'A', typeId: 'some-future-product' }, id: 'a', position: { x: 0, y: 0 } },
      { data: { label: 'B', typeId: 'another-one' }, id: 'b', position: { x: 0, y: 0 } }
    ];

    const [remapped] = remapEdgeHandles(
      [
        {
          id: 'e1',
          source: 'a',
          sourceHandle: 'custom-source',
          target: 'b',
          targetHandle: 'custom-target'
        }
      ],
      unknown,
      'DOWN'
    );

    expect(remapped).toMatchObject({
      sourceHandle: 'custom-source',
      targetHandle: 'custom-target'
    });
  });

  it('leaves an edge alone when it references a node the diagram does not contain', () => {
    const [remapped] = remapEdgeHandles(
      [
        {
          id: 'e1',
          source: 'gone',
          sourceHandle: 'custom-source',
          target: 'also-gone',
          targetHandle: 'custom-target'
        }
      ],
      nodes,
      'DOWN'
    );

    expect(remapped).toMatchObject({
      sourceHandle: 'custom-source',
      targetHandle: 'custom-target'
    });
  });
});

describe('computeAutoLayout', () => {
  it('returns nodes at the positions ELK computed', async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [{ id: 'a', x: 42, y: 99 }] });

    const result = await computeAutoLayout([nodes[0]], [], 'DOWN');

    expect(result?.nodes[0]?.position).toEqual({ x: 42, y: 99 });
    expect(mockElkLayout).toHaveBeenCalledTimes(1);
  });

  it('describes every edge to ELK', async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [] });

    await computeAutoLayout(nodes, [{ id: 'e1', source: 'a', target: 'b' }], 'DOWN');

    expect(mockElkLayout.mock.calls[0]?.[0]).toMatchObject({
      edges: [{ id: 'e1', sources: ['a'], targets: ['b'] }]
    });
  });

  // The ports tell ELK which side of a node an edge leaves from, which is what makes its routing
  // match the handles the canvas actually renders.
  it('describes a node type\u2019s catalogue handles to ELK as ports', async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [] });

    await computeAutoLayout([nodes[0]], [], 'DOWN');

    const graph = mockElkLayout.mock.calls[0]?.[0] as { children: { ports: unknown[] }[] };

    expect(graph.children[0]?.ports.length).toBeGreaterThan(0);
  });

  it('gives a node with no catalogue entry no ports', async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [] });

    await computeAutoLayout(
      [{ data: { label: 'A', typeId: 'gone' }, id: 'a', position: { x: 0, y: 0 } }],
      [],
      'DOWN'
    );

    const graph = mockElkLayout.mock.calls[0]?.[0] as { children: { ports: unknown[] }[] };

    expect(graph.children[0]?.ports).toHaveLength(0);
  });

  it('treats a computed position with no coordinates as the origin', async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [{ id: 'a' }] });

    const result = await computeAutoLayout(
      [{ data: { label: 'A', typeId: 'worker' }, id: 'a', position: { x: 9, y: 9 } }],
      [],
      'DOWN'
    );

    expect(result?.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it('leaves a node ELK did not place where it already was', async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [] });

    const result = await computeAutoLayout(
      [{ data: { label: 'A', typeId: 'worker' }, id: 'a', position: { x: 1, y: 2 } }],
      [],
      'DOWN'
    );

    expect(result?.nodes[0]?.position).toEqual({ x: 1, y: 2 });
  });

  // `null` rather than an empty result, so the caller can tell "ELK computed nothing" from "ELK
  // moved everything to the origin" and leave the canvas untouched.
  it('answers null when ELK returned no children at all', async () => {
    mockElkLayout.mockReset().mockResolvedValue({});

    expect(await computeAutoLayout([nodes[0]], [], 'DOWN')).toBeNull();
  });

  it('propagates a layout failure to the caller', async () => {
    mockElkLayout.mockReset().mockRejectedValue(new Error('layout failed'));

    await expect(computeAutoLayout([], [], 'DOWN')).rejects.toThrow('layout failed');
  });
});
