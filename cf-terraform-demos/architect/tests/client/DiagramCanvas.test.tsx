import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as mockXyflow from './mock-xyflow.tsx';

vi.mock('@xyflow/react', () => mockXyflow);

const { mockGetDiagram, mockSaveDiagramGraph, mockUpdateDiagram } = vi.hoisted(() => ({
  mockGetDiagram: vi.fn(),
  mockSaveDiagramGraph: vi.fn(),
  mockUpdateDiagram: vi.fn()
}));
vi.mock('../../src/client/api/diagrams.ts', () => ({
  getDiagram: mockGetDiagram,
  saveDiagramGraph: mockSaveDiagramGraph,
  updateDiagram: mockUpdateDiagram
}));

const { useDiagramStore } = await import('../../src/client/stores/diagramStore.ts');
const { DiagramCanvas } = await import('../../src/client/components/editor/DiagramCanvas.tsx');

/**
 * @file Covers the editor canvas: loading a diagram, autosaving it, and every way of changing it.
 *   What these tests cannot cover is recorded deliberately. jsdom computes no layout, so nothing
 *   here can fail on where a node actually lands, whether the fitted viewport frames the diagram,
 *   or whether a pointer drag connects two handles. Those are reviewed in a real browser, which is
 *   why the fit-on-load case below asserts only _when_ the fit is requested — the one part of that
 *   behaviour that is this application's decision rather than React Flow's geometry.
 */

/**
 * An empty but well-formed stored graph.
 */
const EMPTY_GRAPH = JSON.stringify({ edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } });

/**
 * Answers the diagram fetch with a loaded diagram.
 *
 * @param overrides Fields to override on the returned diagram.
 */
function respondWithDiagram(overrides: Record<string, unknown> = {}): void {
  mockGetDiagram.mockResolvedValue({
    description: '',
    graphData: EMPTY_GRAPH,
    id: 'd1',
    ownerEmail: 'alice@example.com',
    title: 'My Diagram',
    ...overrides
  });
}

/**
 * Renders the canvas and waits for the diagram to arrive.
 *
 * @returns The render result.
 */
async function renderLoaded() {
  const view = render(<DiagramCanvas diagramId="d1" />);
  await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());
  return view;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ addEventListener: vi.fn(), matches: false, removeEventListener: vi.fn() }))
  );
  useDiagramStore.setState({
    description: '',
    diagramId: null,
    dirty: false,
    detailsPanelExpanded: false,
    edges: [],
    lastSavedAt: null,
    minimapOpen: true,
    nodes: [],
    paletteOpen: true,
    propertiesOpen: false,
    redoStack: [],
    saveError: null,
    saving: false,
    selectedEdgeId: null,
    selectedNodeId: null,
    title: 'Untitled Diagram',
    undoStack: []
  });
  mockGetDiagram.mockReset();
  mockSaveDiagramGraph.mockReset().mockResolvedValue('2026-01-01T00:00:00.000Z');
  mockUpdateDiagram.mockReset().mockResolvedValue({});
  mockXyflow.mockFitView.mockClear();
  mockXyflow.mockUseNodesInitialized.mockReturnValue(true);
  // Restored rather than merely cleared: a test that pins a converted position would otherwise
  // leave that fixed value in place for every test after it.
  mockXyflow.mockScreenToFlowPosition
    .mockReset()
    .mockImplementation((position: { x: number; y: number }) => position);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loading a diagram', () => {
  it('waits rather than showing an empty canvas', () => {
    mockGetDiagram.mockReturnValue(new Promise(() => {}));
    render(<DiagramCanvas diagramId="d1" />);

    expect(screen.getByText('Loading diagram…')).toBeInTheDocument();
    expect(screen.queryByTestId('react-flow')).not.toBeInTheDocument();
  });

  it('shows the diagram once it arrives', async () => {
    respondWithDiagram();
    await renderLoaded();

    expect(screen.getByLabelText('Diagram title')).toHaveValue('My Diagram');
  });

  // The title is in the toolbar as an editable field, which is not a heading — so without this
  // the first heading a screen-reader user meets is the palette's, and the diagram they opened is
  // never announced at all.
  it('heads the page with the diagram\u2019s name', async () => {
    respondWithDiagram();
    await renderLoaded();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'My Diagram — Diagram editor'
    );
  });

  it('reports a failure with a way back', async () => {
    mockGetDiagram.mockRejectedValue(new Error('Diagram not found.'));
    render(<DiagramCanvas diagramId="missing" />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Diagram not found.'));
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/app');
  });

  it('reports a failure that carried no message', async () => {
    mockGetDiagram.mockRejectedValue('boom');
    render(<DiagramCanvas diagramId="missing" />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load diagram.')
    );
  });

  // An editor that refused to open would leave the visitor no way to repair the diagram. An empty
  // canvas they can rebuild and save over is recoverable.
  it.each([
    ['a truncated value', '{not json'],
    ['an empty value', ''],
    ['a value missing every field', '{}']
  ])('opens on an empty canvas for %s', async (_description, graphData) => {
    respondWithDiagram({ graphData });
    await renderLoaded();

    const state = useDiagramStore.getState();

    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('treats a diagram with no description as having an empty one', async () => {
    respondWithDiagram({ description: null });
    await renderLoaded();

    expect(useDiagramStore.getState().description).toBe('');
  });

  // The store outlives this component, so a response arriving after the visitor navigated away
  // would otherwise leave the next editor showing the previous diagram.
  it('discards a diagram that arrives after the editor has gone', async () => {
    let resolveGetDiagram!: (value: unknown) => void;
    mockGetDiagram.mockReturnValue(
      new Promise((resolve) => {
        resolveGetDiagram = resolve;
      })
    );

    const { unmount } = render(<DiagramCanvas diagramId="d1" />);
    unmount();
    resolveGetDiagram({ description: '', graphData: EMPTY_GRAPH, id: 'd1', title: 'My Diagram' });
    await Promise.resolve();

    expect(useDiagramStore.getState().diagramId).toBeNull();
  });

  it('discards a failure that arrives after the editor has gone', async () => {
    let rejectGetDiagram!: (reason: unknown) => void;
    mockGetDiagram.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectGetDiagram = reject;
      })
    );

    const { unmount } = render(<DiagramCanvas diagramId="d1" />);
    unmount();
    rejectGetDiagram(new Error('too late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('framing the diagram on load', () => {
  // React Flow's own `fitView` prop fits at mount, when `CFNode` has no measured size and every
  // node is zero by zero — producing a viewport that leaves the real diagram off screen. jsdom
  // cannot show that, so what is asserted here is the timing decision: not before measurement.
  it('waits until the nodes have been measured', async () => {
    mockXyflow.mockUseNodesInitialized.mockReturnValue(false);
    respondWithDiagram();

    const { rerender } = await renderLoaded();

    expect(mockXyflow.mockFitView).not.toHaveBeenCalled();

    mockXyflow.mockUseNodesInitialized.mockReturnValue(true);
    rerender(<DiagramCanvas diagramId="d1" />);

    await waitFor(() => expect(mockXyflow.mockFitView).toHaveBeenCalledWith({ duration: 0 }));
  });

  // Once only, so it never fights a visitor who has panned somewhere themselves.
  it('frames the diagram once per visit, not on every render', async () => {
    respondWithDiagram();
    const { rerender } = await renderLoaded();

    await waitFor(() => expect(mockXyflow.mockFitView).toHaveBeenCalledTimes(1));

    rerender(<DiagramCanvas diagramId="d1" />);
    rerender(<DiagramCanvas diagramId="d1" />);

    expect(mockXyflow.mockFitView).toHaveBeenCalledTimes(1);
  });
});

describe('autosaving', () => {
  it('saves the whole graph shortly after a change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    useDiagramStore.getState().addNode({
      data: { label: 'Workers', typeId: 'worker' },
      id: 'n1',
      position: { x: 0, y: 0 },
      type: 'cf-node'
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(mockSaveDiagramGraph).toHaveBeenCalledWith('d1', expect.stringContaining('n1'));
    await vi.waitFor(() => expect(useDiagramStore.getState().dirty).toBe(false));
  });

  // One save for a burst of changes, not one per change: dragging a node fires a change on every
  // pointer move.
  it('coalesces a burst of changes into a single save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    for (let index = 0; index < 3; index += 1) {
      useDiagramStore.getState().addNode({
        data: { label: 'Workers', typeId: 'worker' },
        id: `n${index}`,
        position: { x: 0, y: 0 },
        type: 'cf-node'
      });
      await vi.advanceTimersByTimeAsync(100);
    }

    await vi.advanceTimersByTimeAsync(500);

    expect(mockSaveDiagramGraph).toHaveBeenCalledTimes(1);
    // The graph is read when the timer fires rather than when the change happened, so every node
    // of the burst is included.
    expect(mockSaveDiagramGraph.mock.calls[0]?.[1]).toContain('n2');
  });

  it.each([
    ['the message the server gave', new Error('Network error'), 'Network error'],
    ['a generic message when there was none', 'boom', 'Failed to save.']
  ])('surfaces a failed save with %s', async (_description, rejection, expected) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    mockSaveDiagramGraph.mockRejectedValue(rejection);
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    useDiagramStore.getState().addNode({
      data: { label: 'Workers', typeId: 'worker' },
      id: 'n1',
      position: { x: 0, y: 0 },
      type: 'cf-node'
    });
    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => expect(useDiagramStore.getState().saveError).toBe(expected));
    // Still dirty, so the next change retries rather than the failure quietly becoming a saved
    // state.
    expect(useDiagramStore.getState().dirty).toBe(true);
  });

  it('saves a renamed title on its own, longer timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    fireEvent.change(screen.getByLabelText('Diagram title'), { target: { value: 'Renamed' } });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockUpdateDiagram).toHaveBeenCalledWith('d1', { title: 'Renamed' });
  });

  // Deliberately silent: it is retried by the next keystroke, and the status bar reports the
  // graph's save state, which is the one a visitor is actually watching.
  it('does not disturb the editor when a title save fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    mockUpdateDiagram.mockRejectedValue(new Error('Network error'));
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    fireEvent.change(screen.getByLabelText('Diagram title'), { target: { value: 'Renamed' } });
    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => expect(mockUpdateDiagram).toHaveBeenCalled());
    expect(useDiagramStore.getState().saveError).toBeNull();
  });
});

describe('guarding unsaved work', () => {
  it('asks before the tab closes with a change still pending', async () => {
    respondWithDiagram();
    await renderLoaded();
    act(() => useDiagramStore.setState({ dirty: true }));

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('does not ask when everything is saved', async () => {
    respondWithDiagram();
    await renderLoaded();

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('adding a service', () => {
  // The drop point is converted from screen to canvas coordinates before it becomes a position,
  // which is what makes a node land under the pointer rather than wherever the canvas happens to
  // be panned to. jsdom reports no geometry, so the conversion is asserted by the call it makes;
  // where the node visually lands is reviewed in a browser.
  it('adds one dropped from the palette, positioned in canvas coordinates', async () => {
    respondWithDiagram();
    await renderLoaded();
    mockXyflow.mockScreenToFlowPosition.mockClear().mockReturnValue({ x: 64, y: 128 });

    fireEvent.drop(screen.getByTestId('react-flow'), {
      dataTransfer: { getData: () => 'd1' }
    });

    const nodes = useDiagramStore.getState().nodes;

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.data.typeId).toBe('d1');
    expect(nodes[0]?.position).toEqual({ x: 64, y: 128 });
    expect(mockXyflow.mockScreenToFlowPosition).toHaveBeenCalled();
  });

  it('allows a drop to land at all', async () => {
    respondWithDiagram();
    await renderLoaded();
    const dataTransfer = { dropEffect: '' };

    fireEvent.dragOver(screen.getByTestId('react-flow'), { dataTransfer });

    // Without this the browser's default refuses the drop and nothing ever fires.
    expect(dataTransfer.dropEffect).toBe('move');
  });

  // The keyboard path: no drop point exists, so the service arrives in the middle of what the
  // visitor is looking at.
  it('adds one activated from the palette without a pointer', async () => {
    respondWithDiagram();
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Workers' }));

    expect(useDiagramStore.getState().nodes[0]?.data.typeId).toBe('worker');
  });

  it.each([
    ['a drag carrying nothing of ours', ''],
    ['a drag carrying a product we do not have', 'not-a-product']
  ])('ignores %s', async (_description, transferred) => {
    respondWithDiagram();
    await renderLoaded();

    fireEvent.drop(screen.getByTestId('react-flow'), {
      clientX: 10,
      clientY: 20,
      dataTransfer: { getData: () => transferred }
    });

    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });
});

describe('selecting', () => {
  it('selects a node, then an edge, then nothing', async () => {
    respondWithDiagram();
    await renderLoaded();

    fireEvent.click(screen.getByTestId('rf-node-click'));

    expect(useDiagramStore.getState().selectedNodeId).toBe('test-node');

    fireEvent.click(screen.getByTestId('rf-edge-click'));

    expect(useDiagramStore.getState().selectedEdgeId).toBe('test-edge');
    expect(useDiagramStore.getState().selectedNodeId).toBeNull();

    fireEvent.click(screen.getByTestId('rf-pane-click'));

    expect(useDiagramStore.getState().selectedEdgeId).toBeNull();
  });

  it('opens the details panel on the selection', async () => {
    respondWithDiagram();
    await renderLoaded();

    expect(screen.queryByLabelText('Properties')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('rf-node-click'));

    expect(screen.getByRole('button', { name: 'Close properties panel' })).toBeInTheDocument();
  });
});

describe('keyboard shortcuts', () => {
  /**
   * Returns the canvas region, which is what carries the shortcuts.
   *
   * @returns The editor's application region.
   */
  function editorRegion(): HTMLElement {
    return screen.getByRole('application', { name: 'Diagram editor' });
  }

  it('deletes the selection on Delete', async () => {
    respondWithDiagram();
    await renderLoaded();
    act(() =>
      useDiagramStore.setState({
        nodes: [
          {
            data: { label: 'W', typeId: 'worker' },
            id: 'n1',
            position: { x: 0, y: 0 },
            selected: true
          }
        ]
      })
    );

    fireEvent.keyDown(editorRegion(), { key: 'Delete' });

    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  // The single most destructive way this editor could misread a keystroke: Backspace in the title
  // field meaning "delete the selected node".
  it('leaves the selection alone while a text field has focus', async () => {
    respondWithDiagram();
    await renderLoaded();
    act(() =>
      useDiagramStore.setState({
        nodes: [
          {
            data: { label: 'W', typeId: 'worker' },
            id: 'n1',
            position: { x: 0, y: 0 },
            selected: true
          }
        ]
      })
    );

    fireEvent.keyDown(screen.getByLabelText('Diagram title'), { key: 'Backspace' });

    expect(useDiagramStore.getState().nodes).toHaveLength(1);
  });

  it('undoes and redoes from the keyboard', async () => {
    respondWithDiagram();
    await renderLoaded();
    act(() =>
      useDiagramStore.getState().addNode({
        data: { label: 'W', typeId: 'worker' },
        id: 'n1',
        position: { x: 0, y: 0 },
        type: 'cf-node'
      })
    );

    fireEvent.keyDown(editorRegion(), { ctrlKey: true, key: 'z' });

    expect(useDiagramStore.getState().nodes).toHaveLength(0);

    fireEvent.keyDown(editorRegion(), { ctrlKey: true, key: 'Z', shiftKey: true });

    expect(useDiagramStore.getState().nodes).toHaveLength(1);
  });

  // The region handles keys that mean something different here than on an ordinary page, and the
  // tab stop is what lets a keyboard user reach it in the first place.
  it('is reachable from the keyboard as its own interaction region', async () => {
    respondWithDiagram();
    await renderLoaded();

    expect(editorRegion()).toHaveAttribute('tabindex', '0');
  });
});

describe('the panels', () => {
  it('hides the palette when it is toggled off', async () => {
    respondWithDiagram();
    await renderLoaded();

    expect(screen.getByLabelText('Service palette')).toBeInTheDocument();

    act(() => useDiagramStore.getState().togglePalette());

    expect(screen.queryByLabelText('Service palette')).not.toBeInTheDocument();
  });

  it('hides the minimap when it is toggled off', async () => {
    respondWithDiagram();
    await renderLoaded();

    expect(screen.getByTestId('rf-minimap')).toBeInTheDocument();

    act(() => useDiagramStore.getState().toggleMinimap());

    expect(screen.queryByTestId('rf-minimap')).not.toBeInTheDocument();
  });
});

describe('the read-only posture', () => {
  /**
   * A diagram as the anonymous share resolver returns it: no owner, and no timestamps.
   */
  const SHARED = {
    description: 'Public notes',
    graphData: EMPTY_GRAPH,
    id: 'shared-1',
    title: 'Shared Diagram'
  };

  /**
   * Renders the canvas in the share viewer's posture and waits for it to settle.
   *
   * @returns The render result.
   */
  async function renderShared() {
    const view = render(<DiagramCanvas diagramId={SHARED.id} readOnly initialDiagram={SHARED} />);
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());
    return view;
  }

  // The posture exists for a visitor with no Access identity, so the owner-authenticated read
  // would answer `401` for exactly the page they are entitled to see.
  it('renders the diagram it was handed without calling the owner API', async () => {
    await renderShared();

    expect(mockGetDiagram).not.toHaveBeenCalled();
    expect(useDiagramStore.getState().title).toBe('Shared Diagram');
  });

  it('treats an absent description as empty rather than rendering null', async () => {
    render(
      <DiagramCanvas
        diagramId={SHARED.id}
        readOnly
        initialDiagram={{ ...SHARED, description: null }}
      />
    );
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());

    expect(useDiagramStore.getState().description).toBe('');
  });

  // A read-only canvas has nothing to save, and a save it attempted would be refused: the
  // visitor holds a share token, not an identity the diagram API would accept.
  it('never autosaves, however dirty the store is made', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<DiagramCanvas diagramId={SHARED.id} readOnly initialDiagram={SHARED} />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe(SHARED.id));

    act(() => useDiagramStore.setState({ dirty: true }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
    expect(mockUpdateDiagram).not.toHaveBeenCalled();
  });

  it('never asks before the tab closes', async () => {
    await renderShared();
    act(() => useDiagramStore.setState({ dirty: true }));

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  // Not merely inert: left unguarded, the canvas would swallow a Backspace the browser would
  // otherwise treat as "go back".
  it('ignores the editing shortcuts', async () => {
    await renderShared();
    act(() =>
      useDiagramStore.setState({
        nodes: [
          {
            data: { label: 'W', typeId: 'worker' },
            id: 'n1',
            position: { x: 0, y: 0 },
            selected: true,
            type: 'cf-node'
          }
        ],
        selectedNodeId: 'n1'
      })
    );

    fireEvent.keyDown(screen.getByRole('application'), { key: 'Delete' });

    expect(useDiagramStore.getState().nodes).toHaveLength(1);
  });

  it('withholds the editing handlers from the canvas itself', async () => {
    await renderShared();

    const canvas = screen.getByTestId('react-flow');

    expect(canvas).toHaveAttribute('data-nodes-draggable', 'false');
    expect(canvas).toHaveAttribute('data-nodes-connectable', 'false');
  });

  it('withholds the palette and the details panel', async () => {
    act(() => useDiagramStore.setState({ paletteOpen: true, propertiesOpen: true }));
    await renderShared();

    expect(screen.queryByLabelText('Service palette')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Label')).not.toBeInTheDocument();
  });

  it('reports the canvas as read-only rather than as unsaved', async () => {
    await renderShared();

    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  // Reading a diagram still means moving around it, so the view controls and the heading stay.
  it('keeps the heading and fits the diagram into view as the editor does', async () => {
    await renderShared();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Shared Diagram — Diagram editor'
    );
    expect(mockXyflow.mockFitView).toHaveBeenCalled();
  });
});
