import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../../src/catalog.ts';
import type { CFEdgeData } from '../../src/client/components/editor/types.ts';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { useDiagramStore } = await import('../../src/client/stores/diagramStore.ts');
const { DetailsPanel } = await import('../../src/client/components/editor/panels/DetailsPanel.tsx');

/**
 * @file Covers the details panel and the properties form inside it: what each kind of selection
 *   offers to edit, and that every edit reaches the store — which is what makes it saved, since
 *   nothing else is watching these fields — plus the two-tab switch that wraps them.
 */

/**
 * Props for an idle, empty assistant tab.
 *
 * Every test here is about the panel rather than the conversation, so these are inert by default
 * and overridden only where the assertion is about one of them.
 *
 * @returns The five assistant-tab props.
 */
function chatProps() {
  return {
    chatInFlight: false,
    chatTranscript: [],
    onNewConversation: vi.fn(),
    onSendChatMessage: vi.fn(() => true),
    onStopChatTurn: vi.fn()
  };
}

beforeEach(() => {
  localStorage.clear();
  useDiagramStore.setState({
    detailsPanelExpanded: false,
    detailsPanelTab: 'properties',
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
    render(<DetailsPanel {...chatProps()} />);

    expect(screen.getByText('Select a node or edge to view its properties.')).toBeInTheDocument();
  });

  it('can still be closed', () => {
    render(<DetailsPanel {...chatProps()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close properties panel' }));

    expect(useDiagramStore.getState().propertiesOpen).toBe(false);
  });
});

describe('with a node selected', () => {
  it('reports the node\u2019s catalogue type and category', () => {
    selectNode();
    render(<DetailsPanel {...chatProps()} />);

    expect(screen.getByText('Workers')).toBeInTheDocument();
    expect(screen.getByText(CATEGORY_LABELS.compute)).toBeInTheDocument();
  });

  it('edits the label through the store', () => {
    selectNode();
    render(<DetailsPanel {...chatProps()} />);

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Renamed' } });

    expect(useDiagramStore.getState().nodes[0]?.data.label).toBe('Renamed');
  });

  it('edits the description through the store', () => {
    selectNode();
    render(<DetailsPanel {...chatProps()} />);

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Handles requests' }
    });

    expect(useDiagramStore.getState().nodes[0]?.data.description).toBe('Handles requests');
  });

  it('edits the accent colour through the store', () => {
    selectNode();
    render(<DetailsPanel {...chatProps()} />);

    fireEvent.change(screen.getByLabelText('Accent Color'), { target: { value: '#123456' } });

    expect(useDiagramStore.getState().nodes[0]?.data.style?.accentColor).toBe('#123456');
  });

  // A colour input given a value it cannot parse silently shows black, so the default has to be
  // the colour the node is actually painted with rather than anything empty-ish.
  it('defaults the colour input to the category colour', () => {
    selectNode('d1');
    render(<DetailsPanel {...chatProps()} />);

    expect(screen.getByLabelText('Accent Color')).toHaveValue(
      CATEGORY_COLORS.storage.toLowerCase()
    );
  });

  it('keeps an existing accent colour rather than the category default', () => {
    selectNode('worker', { style: { accentColor: '#abcdef' } });
    render(<DetailsPanel {...chatProps()} />);

    expect(screen.getByLabelText('Accent Color')).toHaveValue('#abcdef');
  });

  // A diagram outlives a renamed product, so the stored identifier is shown rather than nothing.
  it('falls back to the stored type and the external category for an unknown product', () => {
    selectNode('no-longer-a-product');
    render(<DetailsPanel {...chatProps()} />);

    expect(screen.getByText('no-longer-a-product')).toBeInTheDocument();
    expect(screen.getByText(CATEGORY_LABELS.external)).toBeInTheDocument();
  });

  it('links the catalogue documentation for the product', () => {
    selectNode();
    render(<DetailsPanel {...chatProps()} />);

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
    render(<DetailsPanel {...chatProps()} />);

    const link = screen.getByRole('link', { name: 'Workers AI Video' });

    expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=cK_leoJsBWY');
    // `react-feather`'s `Video` is the only doc-link glyph drawn with a `<polygon>`; `BookOpen`,
    // the doc icon, is paths alone. That tells the two apart without depending on a class name
    // the stylesheet could rename.
    expect(link.querySelector('polygon')).not.toBeNull();
  });

  it('opens a video documentation link safely in a new tab', () => {
    selectNode('workers-ai');
    render(<DetailsPanel {...chatProps()} />);

    const link = screen.getByRole('link', { name: 'Workers AI Video' });

    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // The icon carries no information the link text does not already give, so a screen reader
  // should announce the title alone rather than reading a decorative glyph before it.
  it('names a documentation link by its title alone, hiding the icon from assistive technology', () => {
    selectNode('workers-ai');
    render(<DetailsPanel {...chatProps()} />);

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
    render(<DetailsPanel {...chatProps()} />);

    const docLink = screen.getByRole('link', { name: 'Workers AI Docs' });
    const videoLink = screen.getByRole('link', { name: 'Workers AI Video' });

    expect(docLink.querySelector('polygon')).toBeNull();
    expect(videoLink.querySelector('polygon')).not.toBeNull();
  });

  it('offers no documentation section for a product that has none', () => {
    selectNode('no-longer-a-product');
    render(<DetailsPanel {...chatProps()} />);

    expect(screen.queryByText('Documentation')).not.toBeInTheDocument();
  });
});

describe('with an edge selected', () => {
  it('edits the edge type through the store', () => {
    selectEdge();
    render(<DetailsPanel {...chatProps()} />);

    expect(screen.getByLabelText('Edge Type')).toHaveValue('data-flow');

    fireEvent.change(screen.getByLabelText('Edge Type'), { target: { value: 'trigger' } });

    expect(useDiagramStore.getState().edges[0]?.data?.edgeType).toBe('trigger');
  });

  it('edits the label, protocol and description through the store', () => {
    selectEdge();
    render(<DetailsPanel {...chatProps()} />);

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
    render(<DetailsPanel {...chatProps()} />);

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
    render(<DetailsPanel {...chatProps()} />);

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
    render(<DetailsPanel {...chatProps()} />);

    expect(screen.getByText('Node Properties')).toBeInTheDocument();
    expect(screen.queryByText('Edge Properties')).not.toBeInTheDocument();
  });
});

describe('the two tabs', () => {
  it('implements the ARIA tabs pattern, with the tabpanel labelled by the active tab', () => {
    render(<DetailsPanel {...chatProps()} />);

    expect(screen.getByRole('tablist', { name: 'Details panel' })).toBeInTheDocument();
    const properties = screen.getByRole('tab', { name: 'Properties' });
    const assistant = screen.getByRole('tab', { name: 'AI Assistant' });
    const tabpanel = screen.getByRole('tabpanel');

    expect(properties).toHaveAttribute('aria-selected', 'true');
    expect(assistant).toHaveAttribute('aria-selected', 'false');
    // The two halves of the pattern have to point at each other, or a screen reader announces a
    // panel with no name and a tab that controls nothing.
    expect(properties).toHaveAttribute('aria-controls', tabpanel.getAttribute('id'));
    expect(assistant).toHaveAttribute('aria-controls', tabpanel.getAttribute('id'));
    expect(tabpanel).toHaveAttribute('aria-labelledby', properties.getAttribute('id'));
  });

  it('shows the assistant and moves the tabpanel label with it', () => {
    render(<DetailsPanel {...chatProps()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'AI Assistant' }));

    expect(useDiagramStore.getState().detailsPanelTab).toBe('ai-chat');
    const assistant = screen.getByRole('tab', { name: 'AI Assistant' });
    expect(assistant).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      assistant.getAttribute('id')
    );
    expect(screen.getByLabelText('Message the AI assistant')).toBeInTheDocument();
    expect(screen.queryByText('Select a node or edge to view its properties.')).toBeNull();
  });

  it('switches back to Properties', () => {
    useDiagramStore.setState({ detailsPanelTab: 'ai-chat' });
    render(<DetailsPanel {...chatProps()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));

    expect(useDiagramStore.getState().detailsPanelTab).toBe('properties');
    expect(screen.getByText('Select a node or edge to view its properties.')).toBeInTheDocument();
  });

  // Selecting something is an explicit statement about what the visitor wants to look at, so it
  // wins over whichever tab happened to be open.
  it.each([
    ['a node', () => useDiagramStore.getState().setSelectedNode('n1')],
    ['an edge', () => useDiagramStore.getState().setSelectedEdge('e1')]
  ])('returns to Properties when %s is selected', (_label, select) => {
    useDiagramStore.setState({ detailsPanelTab: 'ai-chat' });
    render(<DetailsPanel {...chatProps()} />);
    expect(screen.getByRole('tab', { name: 'AI Assistant' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    act(select);

    expect(screen.getByRole('tab', { name: 'Properties' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  // Clearing the selection says nothing about what the panel should show, so it must not drag a
  // reader out of the conversation they were reading.
  it('leaves the assistant tab alone when the selection is cleared', () => {
    useDiagramStore.setState({ detailsPanelTab: 'ai-chat' });
    render(<DetailsPanel {...chatProps()} />);

    act(() => useDiagramStore.getState().setSelectedNode(null));

    expect(useDiagramStore.getState().detailsPanelTab).toBe('ai-chat');
  });

  it('is reachable and operable by keyboard alone', () => {
    render(<DetailsPanel {...chatProps()} />);

    const properties = screen.getByRole('tab', { name: 'Properties' });
    const assistant = screen.getByRole('tab', { name: 'AI Assistant' });
    const expand = screen.getByRole('button', { name: 'Expand panel' });

    // Every control is a real `<button>`, so Tab, Enter and Space work natively; focusing and
    // activating each is what a keyboard pass amounts to here.
    properties.focus();
    expect(document.activeElement).toBe(properties);
    assistant.focus();
    expect(document.activeElement).toBe(assistant);
    fireEvent.click(assistant);
    expect(useDiagramStore.getState().detailsPanelTab).toBe('ai-chat');

    expand.focus();
    expect(document.activeElement).toBe(expand);
    fireEvent.click(expand);
    expect(useDiagramStore.getState().detailsPanelExpanded).toBe(true);
  });

  it('threads the assistant tab\u2019s callbacks through to the panel', () => {
    const props = chatProps();
    useDiagramStore.setState({ detailsPanelTab: 'ai-chat' });
    render(<DetailsPanel {...props} chatTranscript={[{ id: '1', kind: 'user', text: 'Hello' }]} />);

    expect(screen.getByText('Hello')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    expect(props.onNewConversation).toHaveBeenCalledTimes(1);
  });
});

describe('the panel width', () => {
  it('widens and narrows the panel, remembering the choice', () => {
    render(<DetailsPanel {...chatProps()} />);

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
