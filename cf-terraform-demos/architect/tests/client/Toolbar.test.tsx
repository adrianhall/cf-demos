import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { mockAddCollaborator, mockListCollaborators, mockRemoveCollaborator } = vi.hoisted(() => ({
  mockAddCollaborator: vi.fn(),
  mockListCollaborators: vi.fn(),
  mockRemoveCollaborator: vi.fn()
}));
vi.mock('../../src/client/api/diagrams.ts', () => ({
  addCollaborator: mockAddCollaborator,
  listCollaborators: mockListCollaborators,
  removeCollaborator: mockRemoveCollaborator
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
  // The toolbar resolves the viewer's identity for the collaborators dialog, which needs to know
  // which row in its list is the visitor's own.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ email: 'alice@example.com', isAdmin: false })))
  );
  useDiagramStore.setState({
    detailsPanelTab: 'properties',
    diagramId: 'd1',
    edges: [],
    minimapOpen: true,
    nodes: [],
    paletteOpen: true,
    propertiesOpen: false,
    redoStack: [],
    // Explicit in every case rather than left to the store's default, so a test about a
    // collaborator's toolbar cannot pass because a previous test happened to leave the right
    // value behind.
    role: 'owner',
    title: 'My Diagram',
    undoStack: []
  });
  mockListCollaborators.mockReset().mockResolvedValue([]);
  mockAddCollaborator.mockReset();
  mockRemoveCollaborator.mockReset();
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

describe('the AI Assistant control', () => {
  // The control describes what is on screen, so it reports itself pressed only when the panel is
  // both open and showing the assistant.
  it('opens the details panel on the assistant tab', () => {
    render(<Toolbar />);

    const button = screen.getByRole('button', { name: 'AI Assistant' });
    expect(button).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(button);

    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
    expect(useDiagramStore.getState().detailsPanelTab).toBe('ai-chat');
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('leaves an already-open panel open while switching it to the assistant', () => {
    useDiagramStore.setState({ propertiesOpen: true });
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));

    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
    expect(useDiagramStore.getState().detailsPanelTab).toBe('ai-chat');
  });

  it('reports itself unpressed while the assistant tab is chosen but the panel is closed', () => {
    useDiagramStore.setState({ detailsPanelTab: 'ai-chat', propertiesOpen: false });
    render(<Toolbar />);

    expect(screen.getByRole('button', { name: 'AI Assistant' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  // A one-time nudge: the conversation reads better in a wider sidebar, and the palette and the
  // details panel together leave very little canvas on a laptop.
  it('makes room for the conversation by closing the palette, once', () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));

    expect(useDiagramStore.getState().paletteOpen).toBe(false);

    // Reopened deliberately, and a later press must leave that choice alone: a control that kept
    // re-closing a panel the visitor had reopened would be fighting them.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle service palette' }));
    expect(useDiagramStore.getState().paletteOpen).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));

    expect(useDiagramStore.getState().paletteOpen).toBe(true);
  });

  it('leaves an already-closed palette closed', () => {
    useDiagramStore.setState({ paletteOpen: false });
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));

    expect(useDiagramStore.getState().paletteOpen).toBe(false);
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

  // The other menu item, and the default one, so neither branch of the direction choice is
  // reachable only through the option that happens to be tested. `DOWN` is what the button does
  // with no menu at all, so an option that quietly stopped selecting it would look like no change
  // until somebody had switched to `RIGHT` first.
  it('lays out downward when the top-to-bottom option is chosen', async () => {
    withTwoNodes();
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose layout direction' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '↓ Top to bottom' }));

    await waitFor(() => expect(mockElkLayout).toHaveBeenCalled());
    expect(mockElkLayout.mock.calls[0]?.[0]).toMatchObject({
      layoutOptions: { 'elk.direction': 'DOWN' }
    });
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

describe('exporting and printing', () => {
  it('offers both controls', () => {
    render(<Toolbar />);

    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument();
  });

  it('enters print mode from the toolbar', () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));

    expect(useDiagramStore.getState().printMode).toBe(true);
  });

  it('opens the export menu from the toolbar', () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(screen.getByRole('menu')).toBeInTheDocument();
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
    'AI Assistant',
    'Share diagram'
  ])('omits %s entirely', (name) => {
    render(<Toolbar readOnly />);

    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  // A visitor reading a diagram they cannot edit has the same reason to want a PNG of it, a
  // printed copy, or dark mode as its owner — and none of the three writes anything, so none
  // needs the identity the server would refuse them.
  it.each(['Export', 'Print', /appearance/iu])('keeps %s', (name) => {
    render(<Toolbar readOnly />);

    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });
});

describe('the collaborator posture', () => {
  /**
   * Puts the store into the posture of somebody editing a diagram they do not own.
   *
   * @returns Nothing.
   */
  function asCollaborator(): void {
    useDiagramStore.setState({ role: 'editor' });
  }

  // The three owner-only affordances. Each is refused server-side, so the toolbar withholds
  // rather than disables, matching the read-only posture's reasoning: a permanently dead control
  // is a worse answer than its absence, and it is still a tab stop leading nowhere.
  it.each(['Share diagram', 'Manage collaborators'])('omits %s for a collaborator', (name) => {
    asCollaborator();
    render(<Toolbar />);

    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  // Renaming is owner-only, so an editable field whose every save answered `404` would be a worse
  // way to say so than showing the title as what it is.
  it('shows the title as text rather than an editable field', () => {
    asCollaborator();
    render(<Toolbar />);

    expect(screen.queryByLabelText('Diagram title')).not.toBeInTheDocument();
    expect(screen.getByText('My Diagram')).toBeInTheDocument();
  });

  // The read-only view of the same dialog. It is the only route to leaving a diagram, so it has
  // to live somewhere a collaborator can reach.
  it('keeps a way to see who else is editing', () => {
    asCollaborator();
    render(<Toolbar />);

    expect(screen.getByRole('button', { name: 'View collaborators' })).toBeInTheDocument();
  });

  it('opens that dialog without the owner\u2019s add form', async () => {
    asCollaborator();
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'View collaborators' }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.queryByLabelText('Add by email')).not.toBeInTheDocument();
  });

  // Every editing control stays: a grant exists precisely to let somebody change the graph, and
  // withholding the tools for doing so would make it meaningless.
  it.each(['Toggle service palette', 'Connect nodes', 'Undo', 'Zoom in', 'Auto layout'])(
    'keeps %s, because a collaborator may edit the graph',
    (name) => {
      asCollaborator();
      render(<Toolbar />);

      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  );
});

describe('managing collaborators as the owner', () => {
  it('offers the control as something distinct from sharing a link', () => {
    render(<Toolbar />);

    expect(screen.getByRole('button', { name: 'Manage collaborators' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share diagram' })).toBeInTheDocument();
  });

  it('opens the collaborators dialog, not the share one', async () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage collaborators' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Collaborators' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Share Diagram' })).not.toBeInTheDocument();
  });

  it('reads the current list when the dialog opens', async () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage collaborators' }));

    await waitFor(() => expect(mockListCollaborators).toHaveBeenCalledWith('d1'));
  });

  it('closes the dialog again without leaving the editor', async () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage collaborators' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Still on the toolbar: dismissing the dialog is not leaving the diagram.
    expect(screen.getByRole('button', { name: 'Manage collaborators' })).toBeInTheDocument();
  });

  it('asks the server nothing until the dialog is opened', () => {
    render(<Toolbar />);

    expect(mockListCollaborators).not.toHaveBeenCalled();
  });

  // Nothing to ask about before a diagram has loaded.
  it('disables the control until a diagram is loaded', () => {
    useDiagramStore.setState({ diagramId: null });
    render(<Toolbar />);

    expect(screen.getByRole('button', { name: 'Manage collaborators' })).toBeDisabled();
  });

  it('is omitted entirely in the read-only posture', () => {
    render(<Toolbar readOnly />);

    expect(screen.queryByRole('button', { name: 'Manage collaborators' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View collaborators' })).not.toBeInTheDocument();
  });
});

describe('leaving a diagram from the collaborators dialog', () => {
  const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

  afterEach(() => {
    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation);
    }
  });

  // A visitor who has just removed their own access can no longer read this diagram, so the
  // editor is showing something the server would now refuse to send. Returning to the dashboard
  // is the honest next screen; staying would leave a canvas whose next autosave answers `404`.
  it('returns to the dashboard once the viewer has left', async () => {
    useDiagramStore.setState({ role: 'editor' });
    mockListCollaborators.mockResolvedValue([
      {
        addedAt: '2026-02-01T00:00:00.000Z',
        addedBy: 'owner@example.com',
        collaboratorEmail: 'alice@example.com',
        displayName: null,
        diagramId: 'd1'
      }
    ]);
    mockRemoveCollaborator.mockResolvedValue(undefined);
    // jsdom's `location` is read-only, so it is replaced wholesale rather than mutated.
    const location = { ...window.location, href: '/app/diagram/d1' };
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: location,
      writable: true
    });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'View collaborators' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(await screen.findByRole('button', { name: 'Leave this diagram' }));

    await waitFor(() => expect(window.location.href).toBe('/app'));
  });
});
