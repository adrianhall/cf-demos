import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../../src/catalog.ts';
import type { CFEdgeData } from '../../src/client/components/editor/types.ts';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { useDiagramStore } = await import('../../src/client/stores/diagramStore.ts');
const { DetailsPanel } = await import('../../src/client/components/editor/panels/DetailsPanel.tsx');

/**
 * @file Covers the details panel and the properties form inside it: what each kind of selection
 *   offers to edit, and that every edit reaches the store — which is what makes it saved, since
 *   nothing else is watching these fields.
 */

beforeEach(() => {
  localStorage.clear();
  useDiagramStore.setState({
    detailsPanelExpanded: false,
    edges: [],
    nodes: [],
    propertiesOpen: true,
    selectedEdgeId: null,
    selectedNodeId: null
  });
});

/**
 * Selects a node of a given catalogue type.
 *
 * @param typeId Catalogue type, defaulting to Workers.
 * @param data Extra node data merged over the defaults.
 */
function selectNode(typeId = 'worker', data: Record<string, unknown> = {}): void {
  useDiagramStore.setState({
    nodes: [
      {
        data: { label: 'My Worker', typeId, ...data },
        id: 'n1',
        position: { x: 0, y: 0 },
        type: 'cf-node'
      }
    ],
    selectedNodeId: 'n1'
  });
}

/**
 * Selects an edge carrying a data payload.
 *
 * @param data Edge data, or `undefined` for an edge that has none.
 */
function selectEdge(data: CFEdgeData | undefined = { edgeType: 'data-flow' }): void {
  useDiagramStore.setState({
    edges: [{ data, id: 'e1', source: 'a', target: 'b' }],
    selectedEdgeId: 'e1'
  });
}

describe('with nothing selected', () => {
  it('explains what the panel is for', () => {
    render(<DetailsPanel />);

    expect(screen.getByText('Select a node or edge to view its properties.')).toBeInTheDocument();
  });

  it('can still be closed', () => {
    render(<DetailsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Close properties panel' }));

    expect(useDiagramStore.getState().propertiesOpen).toBe(false);
  });
});

describe('with a node selected', () => {
  it('reports the node\u2019s catalogue type and category', () => {
    selectNode();
    render(<DetailsPanel />);

    expect(screen.getByText('Workers')).toBeInTheDocument();
    expect(screen.getByText(CATEGORY_LABELS.compute)).toBeInTheDocument();
  });

  it('edits the label through the store', () => {
    selectNode();
    render(<DetailsPanel />);

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Renamed' } });

    expect(useDiagramStore.getState().nodes[0]?.data.label).toBe('Renamed');
  });

  it('edits the description through the store', () => {
    selectNode();
    render(<DetailsPanel />);

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Handles requests' }
    });

    expect(useDiagramStore.getState().nodes[0]?.data.description).toBe('Handles requests');
  });

  it('edits the accent colour through the store', () => {
    selectNode();
    render(<DetailsPanel />);

    fireEvent.change(screen.getByLabelText('Accent Color'), { target: { value: '#123456' } });

    expect(useDiagramStore.getState().nodes[0]?.data.style?.accentColor).toBe('#123456');
  });

  // A colour input given a value it cannot parse silently shows black, so the default has to be
  // the colour the node is actually painted with rather than anything empty-ish.
  it('defaults the colour input to the category colour', () => {
    selectNode('d1');
    render(<DetailsPanel />);

    expect(screen.getByLabelText('Accent Color')).toHaveValue(
      CATEGORY_COLORS.storage.toLowerCase()
    );
  });

  it('keeps an existing accent colour rather than the category default', () => {
    selectNode('worker', { style: { accentColor: '#abcdef' } });
    render(<DetailsPanel />);

    expect(screen.getByLabelText('Accent Color')).toHaveValue('#abcdef');
  });

  // A diagram outlives a renamed product, so the stored identifier is shown rather than nothing.
  it('falls back to the stored type and the external category for an unknown product', () => {
    selectNode('no-longer-a-product');
    render(<DetailsPanel />);

    expect(screen.getByText('no-longer-a-product')).toBeInTheDocument();
    expect(screen.getByText(CATEGORY_LABELS.external)).toBeInTheDocument();
  });

  it('links the catalogue documentation for the product', () => {
    selectNode();
    render(<DetailsPanel />);

    const link = screen.getByRole('link', { name: 'Workers Docs' });

    expect(link).toHaveAttribute('href', 'https://developers.cloudflare.com/workers/');
    // Opening documentation in the same tab would navigate away from an editor holding unsaved
    // changes, so these are the one place the application opens a new one.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // The video icon was dead code in both this port and its source until the catalogue gained a
  // real `icon: 'video'` entry, so this asserts the icon actually rendered rather than only that
  // the link exists — the doc icon would satisfy a href-only assertion just as well.
  it('marks a video documentation link with the video icon', () => {
    selectNode('workers-ai');
    render(<DetailsPanel />);

    const link = screen.getByRole('link', { name: 'Workers AI Video' });

    expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=cK_leoJsBWY');
    // `react-feather`'s `Video` is the only doc-link glyph drawn with a `<polygon>`; `BookOpen`,
    // the doc icon, is paths alone. That tells the two apart without depending on a class name
    // the stylesheet could rename.
    expect(link.querySelector('polygon')).not.toBeNull();
  });

  it('opens a video documentation link safely in a new tab', () => {
    selectNode('workers-ai');
    render(<DetailsPanel />);

    const link = screen.getByRole('link', { name: 'Workers AI Video' });

    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // The icon carries no information the link text does not already give, so a screen reader
  // should announce the title alone rather than reading a decorative glyph before it.
  it('names a documentation link by its title alone, hiding the icon from assistive technology', () => {
    selectNode('workers-ai');
    render(<DetailsPanel />);

    for (const name of ['Workers AI Docs', 'Workers AI Video']) {
      const icon = screen.getByRole('link', { name }).querySelector('svg');

      expect(icon, `${name} should render an icon`).not.toBeNull();
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
  });

  // Both icon variants have to be reachable from one product, or a regression that swapped the
  // map's two entries would still satisfy a test that only ever looks at one of them.
  it('distinguishes the two documentation-link icons on the same product', () => {
    selectNode('workers-ai');
    render(<DetailsPanel />);

    const docLink = screen.getByRole('link', { name: 'Workers AI Docs' });
    const videoLink = screen.getByRole('link', { name: 'Workers AI Video' });

    expect(docLink.querySelector('polygon')).toBeNull();
    expect(videoLink.querySelector('polygon')).not.toBeNull();
  });

  it('offers no documentation section for a product that has none', () => {
    selectNode('no-longer-a-product');
    render(<DetailsPanel />);

    expect(screen.queryByText('Documentation')).not.toBeInTheDocument();
  });
});

describe('with an edge selected', () => {
  it('edits the edge type through the store', () => {
    selectEdge();
    render(<DetailsPanel />);

    expect(screen.getByLabelText('Edge Type')).toHaveValue('data-flow');

    fireEvent.change(screen.getByLabelText('Edge Type'), { target: { value: 'trigger' } });

    expect(useDiagramStore.getState().edges[0]?.data?.edgeType).toBe('trigger');
  });

  it('edits the label, protocol and description through the store', () => {
    selectEdge();
    render(<DetailsPanel />);

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'HTTPS' } });
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'http' } });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Primary request path' }
    });

    expect(useDiagramStore.getState().edges[0]?.data).toMatchObject({
      description: 'Primary request path',
      label: 'HTTPS',
      protocol: 'http'
    });
  });

  // Clearing it removes the field rather than storing an empty string, so an unannotated edge
  // looks the same whether it has ever been annotated or not.
  it('removes the protocol entirely when reset to None', () => {
    selectEdge({ edgeType: 'data-flow', protocol: 'http' });
    render(<DetailsPanel />);

    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: '' } });

    expect(useDiagramStore.getState().edges[0]?.data?.protocol).toBeUndefined();
  });

  // An edge persisted before the data payload existed has no `data` key at all, and still has to
  // render something editable. Set directly rather than through `selectEdge`, because that
  // helper's default parameter turns an explicit `undefined` into a real data flow — so calling
  // it with `undefined` would assert the ordinary case under the name of this one.
  it('treats an edge with no data at all as a data flow', () => {
    useDiagramStore.setState({
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      selectedEdgeId: 'e1'
    });
    render(<DetailsPanel />);

    expect(screen.getByLabelText('Edge Type')).toHaveValue('data-flow');
  });

  // The store clears one as it sets the other, so this is a safeguard rather than a reachable
  // state — but a panel showing two sets of fields at once would be incoherent.
  it('shows the node when both a node and an edge are somehow selected', () => {
    selectNode();
    useDiagramStore.setState({
      edges: [{ data: { edgeType: 'data-flow' }, id: 'e1', source: 'a', target: 'b' }],
      selectedEdgeId: 'e1'
    });
    render(<DetailsPanel />);

    expect(screen.getByText('Node Properties')).toBeInTheDocument();
    expect(screen.queryByText('Edge Properties')).not.toBeInTheDocument();
  });
});

describe('the panel width', () => {
  it('widens and narrows the panel, remembering the choice', () => {
    render(<DetailsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }));

    expect(screen.getByRole('button', { name: 'Collapse panel' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(localStorage.getItem('details-panel-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));

    expect(screen.getByRole('button', { name: 'Expand panel' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });
});
