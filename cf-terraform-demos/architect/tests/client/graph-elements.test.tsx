import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CATEGORY_COLORS, NODE_TYPE_MAP } from '../../src/catalog.ts';
import { CF_EDGE_TYPE, CF_NODE_TYPE } from '../../src/graph-element-types.ts';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { CFNode } = await import('../../src/client/components/editor/nodes/CFNode.tsx');
const { CFEdge } = await import('../../src/client/components/editor/edges/CFEdge.tsx');
const { nodeTypes } = await import('../../src/client/components/editor/nodes/nodeTypes.ts');
const { edgeTypes } = await import('../../src/client/components/editor/edges/edgeTypes.ts');

/**
 * @file Covers the two canvas renderers and their registries. One generic component renders all 42
 *   products, so these tests exercise the lookup rather than each product: given a `typeId`, does
 *   the node take its icon, colour and handles from the catalogue, and does it still render
 *   something sensible when the catalogue has no entry at all? The second question matters because
 *   a `typeId` comes from persisted data, which can outlive a renamed catalogue entry.
 */

/**
 * Renders {@link CFNode} with the props React Flow would pass.
 *
 * @param data Node data payload.
 * @param selected Whether the node is selected.
 * @returns The render result.
 */
function renderNode(data: Record<string, unknown>, selected = false) {
  const props = { data, id: 'n1', selected } as unknown as Parameters<typeof CFNode>[0];
  return render(<CFNode {...props} />);
}

/**
 * Renders {@link CFEdge} with the props React Flow would pass.
 *
 * @param data Edge data payload, or `undefined` for an edge carrying none.
 * @param selected Whether the edge is selected.
 * @returns The render result.
 */
function renderEdge(data: Record<string, unknown> | undefined, selected = false) {
  const props = {
    data,
    id: 'e1',
    selected,
    sourcePosition: 'right',
    sourceX: 0,
    sourceY: 0,
    targetPosition: 'left',
    targetX: 100,
    targetY: 100
  } as unknown as Parameters<typeof CFEdge>[0];
  return render(<CFEdge {...props} />);
}

describe('registries', () => {
  // Keyed by the shared constants, so an element persisted by any writer resolves to these
  // renderers. A drifted literal would silently fall back to React Flow's unstyled default.
  it('registers the renderers under the shared type keys', () => {
    expect(nodeTypes).toHaveProperty(CF_NODE_TYPE, CFNode);
    expect(edgeTypes).toHaveProperty(CF_EDGE_TYPE, CFEdge);
  });

  it('registers exactly one renderer each', () => {
    expect(Object.keys(nodeTypes)).toHaveLength(1);
    expect(Object.keys(edgeTypes)).toHaveLength(1);
  });
});

describe('CFNode', () => {
  it('shows the node\u2019s label', () => {
    renderNode({ label: 'My Worker', typeId: 'worker' });

    expect(screen.getByText('My Worker')).toBeInTheDocument();
  });

  it('shows a description when the node carries one, and omits it otherwise', () => {
    const { unmount } = renderNode({
      description: 'Handles the API',
      label: 'Workers',
      typeId: 'worker'
    });

    expect(screen.getByText('Handles the API')).toBeInTheDocument();
    unmount();

    const { container } = renderNode({ label: 'Workers', typeId: 'worker' });

    expect(container.querySelector('.cf-node__description')).not.toBeInTheDocument();
  });

  it('takes its accent colour from the catalogue category', () => {
    const { container } = renderNode({ label: 'D1', typeId: 'd1' });

    expect(container.querySelector('.cf-node')).toHaveStyle({
      borderColor: CATEGORY_COLORS.storage
    });
  });

  it('lets a node override its own accent colour', () => {
    const { container } = renderNode({
      label: 'Workers',
      style: { accentColor: '#123456' },
      typeId: 'worker'
    });

    expect(container.querySelector('.cf-node')).toHaveStyle({ borderColor: '#123456' });
  });

  it('renders every handle the catalogue defines for its type', () => {
    const typeDef = NODE_TYPE_MAP.get('worker');
    renderNode({ label: 'Workers', typeId: 'worker' });

    for (const handle of typeDef?.defaultHandles ?? []) {
      expect(screen.getByTestId(`handle-${handle.id}`)).toHaveAttribute(
        'data-handle-type',
        handle.type
      );
    }
  });

  it('renders only the handles a source-only type defines', () => {
    const typeDef = NODE_TYPE_MAP.get('client-browser');
    const { container } = renderNode({ label: 'Client', typeId: 'client-browser' });

    expect(container.querySelectorAll('[data-handle-type]')).toHaveLength(
      typeDef?.defaultHandles.length ?? 0
    );
    expect(container.querySelectorAll('[data-handle-type="target"]')).toHaveLength(0);
  });

  // A `typeId` comes from persisted diagram data, which outlives a renamed catalogue entry. The
  // node has to degrade to a labelled box rather than an empty one.
  describe('an unrecognised product type', () => {
    it('still shows the stored label', () => {
      renderNode({ label: 'Legacy Service', typeId: 'no-such-product' });

      expect(screen.getByText('Legacy Service')).toBeInTheDocument();
    });

    it('falls back to the external category colour', () => {
      const { container } = renderNode({ label: 'Legacy', typeId: 'no-such-product' });

      expect(container.querySelector('.cf-node')).toHaveStyle({
        borderColor: CATEGORY_COLORS.external
      });
    });

    it('renders no handles rather than guessing at them', () => {
      const { container } = renderNode({ label: 'Legacy', typeId: 'no-such-product' });

      expect(container.querySelectorAll('[data-handle-type]')).toHaveLength(0);
    });
  });

  describe('selection', () => {
    // Full-opacity borders in both states: a 40%-alpha unselected border failed WCAG 1.4.11's 3:1
    // non-text minimum, and the border is the only cue the node is a discrete object.
    it('keeps the same full-opacity border when unselected', () => {
      const { container } = renderNode({ label: 'Workers', typeId: 'worker' }, false);

      expect(container.querySelector('.cf-node')).toHaveStyle({
        borderColor: CATEGORY_COLORS.compute,
        boxShadow: 'none'
      });
    });

    it('marks selection with a ring rather than by changing the border', () => {
      const { container } = renderNode({ label: 'Workers', typeId: 'worker' }, true);
      const node = container.querySelector('.cf-node');

      expect(node).toHaveStyle({ borderColor: CATEGORY_COLORS.compute });
      expect(node?.getAttribute('style')).toContain('box-shadow');
    });
  });
});

describe('CFEdge', () => {
  it('renders a path for the edge', () => {
    renderEdge({ edgeType: 'data-flow' });

    expect(screen.getByTestId('base-edge')).toBeInTheDocument();
  });

  it.each([
    ['data-flow', '#F6821F'],
    ['service-binding', '#3B82F6'],
    ['trigger', '#F59E0B'],
    ['external', '#9CA3AF']
  ])('strokes a %s edge in its catalogue colour', (edgeType, color) => {
    renderEdge({ edgeType });

    expect(screen.getByTestId('base-edge')).toHaveStyle({ stroke: color });
  });

  it.each([
    ['service-binding', '8 4'],
    ['trigger', '3 3']
  ])('dashes a %s edge', (edgeType, dashArray) => {
    renderEdge({ edgeType });

    expect(screen.getByTestId('base-edge')).toHaveStyle({ strokeDasharray: dashArray });
  });

  it('leaves a solid edge undashed', () => {
    renderEdge({ edgeType: 'data-flow' });

    expect(screen.getByTestId('base-edge').style.strokeDasharray).toBe('');
  });

  it('highlights a selected edge in the brand colour and thickens it', () => {
    renderEdge({ edgeType: 'service-binding' }, true);

    expect(screen.getByTestId('base-edge')).toHaveStyle({
      stroke: '#F6821F',
      strokeWidth: '2.5'
    });
  });

  // This application's own class, which carries the reduced-motion guard. React Flow's built-in
  // animation class keys off a wrapper this component never renders, so it would match no rule.
  it('animates a data-flow edge through the application\u2019s own class', () => {
    renderEdge({ edgeType: 'data-flow' });

    expect(screen.getByTestId('base-edge')).toHaveClass('cf-edge-animated');
  });

  it('leaves a non-animated edge type unanimated', () => {
    renderEdge({ edgeType: 'service-binding' });

    expect(screen.getByTestId('base-edge')).not.toHaveClass('cf-edge-animated');
  });

  it('renders a midpoint label when the edge carries one', () => {
    renderEdge({ edgeType: 'data-flow', label: 'HTTPS' });

    expect(screen.getByText('HTTPS')).toBeInTheDocument();
  });

  it('renders no label container when the edge has no label', () => {
    renderEdge({ edgeType: 'data-flow' });

    expect(screen.queryByTestId('edge-label-renderer')).not.toBeInTheDocument();
  });

  it('attaches an arrowhead only to a type that defines one', () => {
    renderEdge({ edgeType: 'data-flow' });

    expect(screen.getByTestId('base-edge')).toHaveAttribute(
      'data-marker-end',
      'url(#cf-edge-arrow-data-flow)'
    );
  });

  // Edge data also comes from persisted graphs, so both an absent payload and an unknown type have
  // to render a visible connection rather than nothing.
  it.each([
    ['no data at all', undefined],
    ['an unrecognised edge type', { edgeType: 'no-such-type' }]
  ])('still renders a visible edge for %s', (_label, data) => {
    renderEdge(data);

    const edge = screen.getByTestId('base-edge');

    expect(edge).toBeInTheDocument();
    expect(edge.style.stroke).not.toBe('');
  });

  it('defaults a payload-less edge to the data-flow treatment', () => {
    renderEdge(undefined);

    expect(screen.getByTestId('base-edge')).toHaveStyle({ stroke: '#F6821F' });
  });
});
