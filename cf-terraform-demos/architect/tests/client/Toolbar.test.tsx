import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as mockXyflow from './mock-xyflow.tsx';

vi.mock('@xyflow/react', () => mockXyflow);

const { mockElkLayout } = vi.hoisted(() => ({ mockElkLayout: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class MockElk {
    layout = mockElkLayout;
  }
}));

const { mockCreateShare, mockGetShareStatus, mockRevokeShare } = vi.hoisted(() => ({
  mockCreateShare: vi.fn(),
  mockGetShareStatus: vi.fn(),
  mockRevokeShare: vi.fn()
}));
vi.mock('../../src/client/api/shares.ts', () => ({
  createShare: mockCreateShare,
  getShareStatus: mockGetShareStatus,
  revokeShare: mockRevokeShare
}));

const { useDiagramStore } = await import('../../src/client/stores/diagramStore.ts');
const { Toolbar } = await import('../../src/client/components/editor/toolbar/Toolbar.tsx');

/**
 * @file Covers the toolbar: which controls exist in each posture, and what they do to the store and
 *   the canvas. ELK is stubbed, so the auto-layout cases assert the toolbar's own side effects —
 *   one undo step, the new positions, a fitted view — rather than a layout engine's output.
 */

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ addEventListener: vi.fn(), matches: false, removeEventListener: vi.fn() }))
  );
  useDiagramStore.setState({
    diagramId: 'd1',
    edges: [],
    minimapOpen: true,
    nodes: [],
    paletteOpen: true,
    propertiesOpen: false,
    redoStack: [],
    title: 'My Diagram',
    undoStack: []
  });
  mockXyflow.mockFitView.mockClear();
  mockXyflow.mockZoomIn.mockClear();
  mockXyflow.mockZoomOut.mockClear();
  mockElkLayout.mockReset().mockResolvedValue({ children: [] });
  mockGetShareStatus.mockReset().mockResolvedValue({ active: false, createdAt: null });
  mockCreateShare.mockReset();
  mockRevokeShare.mockReset();
});

/**
 * Puts two connected nodes on the canvas, enough for a connection and a layout.
 */
function withTwoNodes(): void {
  useDiagramStore.setState({
    edges: [{ data: { edgeType: 'data-flow' }, id: 'e1', source: 'a', target: 'b' }],
    nodes: [
      {
        data: { label: 'A', typeId: 'worker' },
        id: 'a',
        position: { x: 0, y: 0 },
        type: 'cf-node'
      },
      { data: { label: 'B', typeId: 'd1' }, id: 'b', position: { x: 10, y: 10 }, type: 'cf-node' }
    ]
  });
}

describe('the diagram title', () => {
  it('edits the title through the store', () => {
    render(<Toolbar />);

    fireEvent.change(screen.getByLabelText('Diagram title'), { target: { value: 'Renamed' } });

    expect(useDiagramStore.getState().title).toBe('Renamed');
  });

  // The field has no visible label — the title is self-evidently a title — so the hidden one is
  // the only thing naming it for a screen reader.
  it('names the field for assistive technology', () => {
    render(<Toolbar />);

    expect(screen.getByLabelText('Diagram title')).toHaveValue('My Diagram');
  });

  it('shows the title as plain text when the canvas is read-only', () => {
    render(<Toolbar readOnly />);

    expect(screen.queryByLabelText('Diagram title')).not.toBeInTheDocument();
    expect(screen.getByText('My Diagram')).toBeInTheDocument();
  });
});

describe('leaving the editor', () => {
  // A real anchor, because `/app` is behind Cloudflare Access: only a document request lets
  // Access intercept it before the bundle for that page runs.
  it('links back to the dashboard with a real document navigation', () => {
    render(<Toolbar />);

    const link = screen.getByRole('link', { name: 'Back to dashboard' });

    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/app');
  });
});

describe('the panel toggles', () => {
  it.each([
    ['Toggle service palette', 'paletteOpen', true],
    ['Toggle properties panel', 'propertiesOpen', false],
    ['Toggle minimap', 'minimapOpen', true]
  ] as const)('toggles %s', (name, key, initiallyOpen) => {
    render(<Toolbar />);

    const button = screen.getByRole('button', { name });

    // The state belongs in `aria-pressed` rather than in a label that changes, so the control is
    // announced as the same button whichever way it is set.
    expect(button).toHaveAttribute('aria-pressed', String(initiallyOpen));

    fireEvent.click(button);

    expect(useDiagramStore.getState()[key]).toBe(!initiallyOpen);
    expect(button).toHaveAttribute('aria-pressed', String(!initiallyOpen));
  });
});

describe('undo and redo', () => {
  // Disabled rather than hidden: the controls are a permanent part of the toolbar, and their
  // disabled state is what says there is nothing to undo yet.
  it('offers neither until there is history', () => {
    render(<Toolbar />);

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });

  it('undoes and redoes through the store', () => {
    render(<Toolbar />);

    act(() =>
      useDiagramStore.getState().addNode({
        data: { label: 'A', typeId: 'worker' },
        id: 'a',
        position: { x: 0, y: 0 },
        type: 'cf-node'
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(useDiagramStore.getState().nodes).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));

    expect(useDiagramStore.getState().nodes).toHaveLength(1);
  });
});

describe('the view controls', () => {
  it.each([
    ['Zoom in', (): unknown => mockXyflow.mockZoomIn],
    ['Zoom out', (): unknown => mockXyflow.mockZoomOut],
    ['Fit view', (): unknown => mockXyflow.mockFitView]
  ])('drives the canvas from %s', (name, spy) => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name }));

    expect(spy()).toHaveBeenCalled();
  });
});

describe('connecting nodes', () => {
  // Nothing to join below two nodes, so the control says so rather than opening a dialog with
  // empty dropdowns.
  it('is unavailable until there are two nodes to join', () => {
    render(<Toolbar />);

    expect(screen.getByRole('button', { name: 'Connect nodes' })).toBeDisabled();
  });

  it('opens the dialog once there are', () => {
    withTwoNodes();
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect nodes' }));

    expect(screen.getByRole('dialog', { name: 'Connect Nodes' })).toBeInTheDocument();
  });

  it('closes the dialog again', () => {
    withTwoNodes();
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('auto layout', () => {
  it('applies the computed positions and fits the view', async () => {
    withTwoNodes();
    mockElkLayout.mockResolvedValue({ children: [{ id: 'a', x: 42, y: 99 }] });
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Auto layout' }));

    await waitFor(() =>
      expect(useDiagramStore.getState().nodes[0]?.position).toEqual({ x: 42, y: 99 })
    );
    await waitFor(() => expect(mockXyflow.mockFitView).toHaveBeenCalled());
  });

  // One entry, not one per node: a visitor who dislikes the result wants their diagram back, not
  // forty presses of Ctrl+Z.
  it('is a single undo step however many nodes moved', async () => {
    withTwoNodes();
    mockElkLayout.mockResolvedValue({
      children: [
        { id: 'a', x: 1, y: 1 },
        { id: 'b', x: 2, y: 2 }
      ]
    });
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Auto layout' }));

    await waitFor(() => expect(useDiagramStore.getState().undoStack).toHaveLength(1));
  });

  it('chooses a direction from the menu and lays out immediately', async () => {
    withTwoNodes();
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose layout direction' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '→ Left to right' }));

    await waitFor(() => expect(mockElkLayout).toHaveBeenCalled());
    expect(mockElkLayout.mock.calls[0]?.[0]).toMatchObject({
      layoutOptions: { 'elk.direction': 'RIGHT' }
    });
    // The menu closes behind the choice rather than staying open over the canvas it just changed.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('remembers the chosen direction for the next press', async () => {
    withTwoNodes();
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose layout direction' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '→ Left to right' }));
    await waitFor(() => expect(mockElkLayout).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Auto layout' }));

    await waitFor(() => expect(mockElkLayout).toHaveBeenCalledTimes(2));
    expect(mockElkLayout.mock.calls[1]?.[0]).toMatchObject({
      layoutOptions: { 'elk.direction': 'RIGHT' }
    });
  });

  it('dismisses the direction menu on Escape', () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose layout direction' }));

    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('leaves the canvas alone when the layout computed nothing', async () => {
    withTwoNodes();
    mockElkLayout.mockResolvedValue({});
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Auto layout' }));

    await waitFor(() => expect(mockXyflow.mockFitView).toHaveBeenCalled());
    expect(useDiagramStore.getState().nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(useDiagramStore.getState().undoStack).toHaveLength(0);
  });

  // ELK is fetched on demand, so the realistic failure is the chunk not arriving — an ordinary
  // offline moment. It must leave the diagram untouched, say so, and leave a button that can be
  // pressed again rather than a permanently dead control.
  it('reports a failed layout and stays usable', async () => {
    withTwoNodes();
    mockElkLayout.mockRejectedValue(new Error('layout failed'));
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Auto layout' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not lay out this diagram.')
    );
    expect(screen.getByRole('button', { name: 'Auto layout' })).toBeEnabled();
    expect(useDiagramStore.getState().nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it('clears a previous failure when a later layout succeeds', async () => {
    withTwoNodes();
    mockElkLayout.mockRejectedValueOnce(new Error('layout failed'));
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Auto layout' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    mockElkLayout.mockResolvedValue({ children: [{ id: 'a', x: 5, y: 5 }] });
    fireEvent.click(screen.getByRole('button', { name: 'Auto layout' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('sharing', () => {
  it('opens the share controls', async () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Share diagram' }));

    expect(await screen.findByRole('dialog', { name: 'Share Diagram' })).toBeInTheDocument();
    expect(mockGetShareStatus).toHaveBeenCalledWith('d1');
  });

  it('closes them again', async () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Share diagram' }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  // Nothing to share before a diagram has loaded, and the modal's first act would be to ask the
  // server about a diagram that does not exist yet.
  it('is unavailable until a diagram is loaded', () => {
    useDiagramStore.setState({ diagramId: null });
    render(<Toolbar />);

    expect(screen.getByRole('button', { name: 'Share diagram' })).toBeDisabled();
    expect(mockGetShareStatus).not.toHaveBeenCalled();
  });
});

describe('the read-only posture', () => {
  // Omitted rather than disabled: a row of permanently dead buttons is a worse answer than their
  // absence, and each would still be a tab stop leading nowhere. Sharing is on this list for a
  // second reason: an anonymous viewer arrived through somebody else's link, and the server would
  // refuse a request to mint one of their own.
  it.each([
    'Toggle service palette',
    'Connect nodes',
    'Undo',
    'Redo',
    'Zoom in',
    'Auto layout',
    'Share diagram'
  ])('omits %s entirely', (name) => {
    render(<Toolbar readOnly />);

    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  // A visitor reading a diagram they cannot edit has the same reason to want dark mode as its
  // owner.
  it('keeps the appearance control', () => {
    render(<Toolbar readOnly />);

    expect(screen.getByRole('button', { name: /appearance/iu })).toBeInTheDocument();
  });
});
