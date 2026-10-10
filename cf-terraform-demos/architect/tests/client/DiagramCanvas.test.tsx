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
  addCollaborator: vi.fn(),
  // The real URL builder rather than a stub: it is pure, it is the thing a test asserting on the
  // socket's address cares about, and mocking it would make that assertion a tautology.
  diagramLiveUrl: (id: string) => `ws://localhost/api/diagrams/${encodeURIComponent(id)}/live`,
  // The canvas loads through `getAccessibleDiagram`, which answers with the diagram and the
  // caller's role together. `mockGetDiagram` stays the diagram source so every assertion in this
  // file keeps reading as a statement about the diagram, with the owner role supplied around it;
  // what the role itself changes is the toolbar's business, and is covered in `./Toolbar.test.tsx`.
  getAccessibleDiagram: async (id: string) => ({
    diagram: (await mockGetDiagram(id)) as unknown,
    role: 'owner' as const
  }),
  listCollaborators: vi.fn(async () => []),
  removeCollaborator: vi.fn(),
  saveDiagramGraph: mockSaveDiagramGraph,
  updateDiagram: mockUpdateDiagram
}));

// ELK is a 1.4 MB layout engine the canvas reaches through a dynamic import, so the assistant's
// post-turn pass is asserted against a stub exactly as `./auto-layout.test.ts` asserts the module
// itself. What is under test here is *that* one pass runs and what it persists, never how well a
// third-party engine arranges a graph.
const { mockElkLayout } = vi.hoisted(() => ({ mockElkLayout: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class MockElk {
    layout = mockElkLayout;
  }
}));

const { installFakeWebSocket, mostRecentSocket, FakeWebSocket } =
  await import('./fake-websocket.ts');
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
  // jsdom has no WebSocket at all, so the canvas's live-sync effect would throw on mount in every
  // test in this file without a double in place.
  installFakeWebSocket();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ addEventListener: vi.fn(), matches: false, removeEventListener: vi.fn() }))
  );
  mockElkLayout.mockReset().mockResolvedValue({ children: [] });
  useDiagramStore.setState({
    description: '',
    diagramId: null,
    dirty: false,
    detailsPanelExpanded: false,
    detailsPanelTab: 'properties',
    edges: [],
    lastSavedAt: null,
    minimapOpen: true,
    nodes: [],
    paletteOpen: true,
    printMode: false,
    propertiesOpen: false,
    redoStack: [],
    saveError: null,
    saving: false,
    selectedEdgeId: null,
    selectedNodeId: null,
    title: 'Untitled Diagram',
    undoStack: [],
    updatedAt: null
  });
  mockGetDiagram.mockReset();
  mockSaveDiagramGraph.mockReset().mockResolvedValue('2026-01-01T00:00:00.000Z');
  mockUpdateDiagram.mockReset().mockResolvedValue({});
  mockXyflow.mockFitView.mockClear();
  mockXyflow.mockGetNodes.mockReset().mockReturnValue([]);
  mockXyflow.mockGetNodesBounds.mockReset().mockReturnValue({
    height: 300,
    width: 400,
    x: 0,
    y: 0
  });
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
  // Print mode writes to `document`, which is shared across the whole file. The canvas's own
  // cleanup undoes it, but a test that asserts the undo has to start from a known state rather
  // than from whatever the previous one left.
  document.documentElement.style.removeProperty('color-scheme');
  document.body.classList.remove('diagram-editor-print-mode');
  document.getElementById('diagram-editor-print-orientation')?.remove();
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

describe('live awareness', () => {
  it('renders joined participants, remote cursor and selected node without dirtying the graph', async () => {
    respondWithDiagram({
      graphData: JSON.stringify({
        edges: [],
        nodes: [
          {
            data: { label: 'API', typeId: 'worker' },
            id: 'test-node',
            position: { x: 0, y: 0 },
            type: 'cf-node'
          }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      })
    });
    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    await act(async () => {
      mostRecentSocket().simulateMessage({
        participants: [{ color: '#127fda', email: 'mallory@example.com' }],
        type: 'presence_snapshot'
      });
      mostRecentSocket().simulateMessage({
        color: '#127fda',
        email: 'mallory@example.com',
        type: 'cursor_moved',
        x: 12,
        y: 34
      });
      mostRecentSocket().simulateMessage({
        color: '#127fda',
        edgeId: null,
        email: 'mallory@example.com',
        nodeId: 'test-node',
        type: 'selection_changed'
      });
    });

    expect(screen.getByLabelText('Currently viewing this diagram')).toHaveTextContent('M');
    expect(screen.getByLabelText('mallory@example.com')).toBeInTheDocument();
    expect(document.querySelector('.remote-cursor')).toHaveTextContent('mallory');
    expect(document.querySelector('.remote-selection-highlight')).toBeInTheDocument();
    expect(useDiagramStore.getState().dirty).toBe(false);
  });

  it('removes departed awareness without changing the graph', async () => {
    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    await act(async () => {
      mostRecentSocket().simulateMessage({
        participants: [{ color: '#127fda', email: 'mallory@example.com' }],
        type: 'presence_snapshot'
      });
      mostRecentSocket().simulateMessage({
        color: '#127fda',
        email: 'mallory@example.com',
        type: 'cursor_moved',
        x: 12,
        y: 34
      });
      mostRecentSocket().simulateMessage({ email: 'mallory@example.com', type: 'presence_left' });
    });

    expect(screen.queryByLabelText('Currently viewing this diagram')).not.toBeInTheDocument();
    expect(document.querySelector('.remote-cursor')).not.toBeInTheDocument();
    expect(useDiagramStore.getState().dirty).toBe(false);
  });
});

describe('autosaving', () => {
  it('sends debounced operations while connected and stops using the REST save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    useDiagramStore.getState().addNode({
      data: { label: 'Workers', typeId: 'worker' },
      id: 'n1',
      position: { x: 16, y: 32 },
      type: 'cf-node'
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
    const sent = JSON.parse(mostRecentSocket().sent[0] as string) as {
      operation: { input: { id: string; position: { x: number; y: number } }; kind: string };
      operationId: string;
      type: string;
    };
    expect(sent).toMatchObject({
      operation: { input: { id: 'n1', position: { x: 16, y: 32 } }, kind: 'add_node' },
      operationId: expect.any(String) as string,
      type: 'operation'
    });
    // Optimistic until the server echoes acceptance.
    expect(useDiagramStore.getState().dirty).toBe(true);

    await act(async () => {
      mostRecentSocket().simulateMessage({
        actor: 'alice@example.com',
        operation: sent.operation,
        operationId: sent.operationId,
        origin: 'human',
        sequence: 1,
        type: 'operation_applied',
        updatedAt: '2026-02-01T00:00:00.000Z'
      });
    });

    expect(useDiagramStore.getState().dirty).toBe(false);
    expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['n1']);
  });

  // A remote operation can be ordered before a local operation that this tab already drew and sent.
  // The canvas must follow the server's order while preserving both optimistic edits.
  it('reconciles a remote operation that interleaves with a pending local edit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    useDiagramStore.getState().addNode({
      data: { label: 'Mine', typeId: 'worker' },
      id: 'mine',
      position: { x: 0, y: 0 },
      type: 'cf-node'
    });
    await vi.advanceTimersByTimeAsync(500);
    const local = JSON.parse(mostRecentSocket().sent[0] as string) as {
      operation: Record<string, unknown>;
      operationId: string;
    };

    // Somebody else's operation reached the session first.
    await act(async () => {
      mostRecentSocket().simulateMessage({
        actor: 'other@example.com',
        operation: {
          input: { id: 'theirs', label: 'Theirs', position: { x: 10, y: 10 }, typeId: 'd1' },
          kind: 'add_node'
        },
        operationId: null,
        origin: 'human',
        sequence: 1,
        type: 'operation_applied',
        updatedAt: '2026-02-01T00:00:00.000Z'
      });
    });
    expect(mostRecentSocket().sent).toHaveLength(1);
    expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['theirs', 'mine']);

    // Then the local operation's echo. It is not applied twice, and both remain in server order.
    await act(async () => {
      mostRecentSocket().simulateMessage({
        actor: 'alice@example.com',
        operation: local.operation,
        operationId: local.operationId,
        origin: 'human',
        sequence: 2,
        type: 'operation_applied',
        updatedAt: '2026-02-01T00:00:01.000Z'
      });
    });

    expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['theirs', 'mine']);
    expect(useDiagramStore.getState().dirty).toBe(false);
  });

  // A rejected optimistic operation must be rolled back to what the session actually holds. The
  // client asks for a snapshot rather than guessing which part of its optimistic graph to undo.
  it('requests a snapshot and rolls back an operation the session rejected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    useDiagramStore.getState().addNode({
      data: { label: 'Rejected', typeId: 'worker' },
      id: 'rejected',
      position: { x: 0, y: 0 },
      type: 'cf-node'
    });
    await vi.advanceTimersByTimeAsync(500);
    const local = JSON.parse(mostRecentSocket().sent[0] as string) as { operationId: string };

    await act(async () => {
      mostRecentSocket().simulateMessage({
        detail: 'A node with id "rejected" already exists.',
        operationId: local.operationId,
        status: 400,
        type: 'operation_rejected'
      });
    });
    expect(mostRecentSocket().sent.at(-1)).toBe(JSON.stringify({ type: 'resync' }));

    await act(async () => {
      mostRecentSocket().simulateMessage({
        actor: null,
        graphData: EMPTY_GRAPH,
        origin: null,
        sequence: 0,
        type: 'snapshot',
        updatedAt: '2026-02-01T00:00:00.000Z'
      });
    });

    expect(useDiagramStore.getState().nodes).toEqual([]);
    expect(useDiagramStore.getState().saveError).toContain('already exists');
  });

  // One batch for a burst, not one frame per keystroke or pointer move. The existing debounce is
  // reused; only the payload changed from a whole graph to the operations that describe it.
  it('coalesces a burst into operations when connected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));

    for (let index = 0; index < 3; index += 1) {
      useDiagramStore.getState().addNode({
        data: { label: `Node ${index}`, typeId: 'worker' },
        id: `n${index}`,
        position: { x: index * 16, y: 0 },
        type: 'cf-node'
      });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(mostRecentSocket().sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);

    expect(mostRecentSocket().sent).toHaveLength(3);
    expect(
      mostRecentSocket().sent.map(
        (payload) =>
          (JSON.parse(payload) as { operation: { input: { id: string } } }).operation.input.id
      )
    ).toEqual(['n0', 'n1', 'n2']);
    expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
  });

  it('falls back to saving the whole graph shortly after a change while disconnected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));
    mostRecentSocket().readyState = FakeWebSocket.CLOSED;

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
    mostRecentSocket().readyState = FakeWebSocket.CLOSED;

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
    mostRecentSocket().readyState = FakeWebSocket.CLOSED;

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

describe('print mode', () => {
  /**
   * The injected `@page` rule's element, if print mode added one.
   *
   * @returns The style element, or `null`.
   */
  function orientationStyle(): HTMLElement | null {
    return document.getElementById('diagram-editor-print-orientation');
  }

  /**
   * Renders the canvas and enters print mode.
   *
   * @returns The render result.
   */
  async function renderPrinting() {
    respondWithDiagram();
    const view = await renderLoaded();
    await act(async () => {
      useDiagramStore.getState().setPrintMode(true);
    });
    return view;
  }

  // A printed diagram should carry the diagram and nothing else: the toolbar, the panels, the
  // status bar, the grid, the minimap and the canvas controls are all chrome.
  it('strips every piece of chrome from the page', async () => {
    await renderPrinting();

    expect(screen.queryByLabelText('Diagram title')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Service palette')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rf-background')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rf-minimap')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rf-controls')).not.toBeInTheDocument();
  });

  // The title lives in the toolbar, which print mode has just removed — so without this the
  // paper carries a diagram with no name on it.
  it('puts the diagram\u2019s name and description on the printed page', async () => {
    mockGetDiagram.mockResolvedValue({
      description: 'How the pieces fit together',
      graphData: EMPTY_GRAPH,
      id: 'd1',
      ownerEmail: 'alice@example.com',
      title: 'My Diagram'
    });
    const view = render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());
    await act(async () => {
      useDiagramStore.getState().setPrintMode(true);
    });

    expect(screen.getByRole('heading', { level: 2, name: 'My Diagram' })).toBeInTheDocument();
    expect(screen.getByText('How the pieces fit together')).toBeInTheDocument();

    view.unmount();
  });

  it('omits the description block for a diagram that has none', async () => {
    await renderPrinting();

    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
    expect(document.querySelector('.diagram-editor__print-description')).toBeNull();
  });

  // A dark-mode diagram prints as a page of black ink. The override is an inline `color-scheme`
  // because that is what drives every `light-dark()` value in the stylesheet.
  it('forces a light colour scheme', async () => {
    await renderPrinting();

    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('marks the document so the print-only stylesheet rules apply', async () => {
    await renderPrinting();

    expect(document.body.classList.contains('diagram-editor-print-mode')).toBe(true);
  });

  // A wide architecture on a portrait page is scaled down to nothing, so the orientation is
  // chosen from the diagram's own shape rather than fixed in the stylesheet.
  it.each([
    ['landscape', { height: 300, width: 900, x: 0, y: 0 }, 'landscape'],
    ['portrait', { height: 900, width: 300, x: 0, y: 0 }, 'portrait']
  ])('chooses a %s page for a diagram of that shape', async (_name, bounds, expected) => {
    mockXyflow.mockGetNodes.mockReturnValue([{ id: 'n1' }]);
    mockXyflow.mockGetNodesBounds.mockReturnValue(bounds);

    await renderPrinting();

    expect(orientationStyle()?.textContent).toContain(`size: ${expected}`);
  });

  // No shape to infer one from, and a printed page of a blank canvas is the same either way.
  it('chooses landscape for an empty diagram', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([]);

    await renderPrinting();

    expect(orientationStyle()?.textContent).toContain('size: landscape');
  });

  // Printing captures the page as it stands, so whatever the visitor had panned to is what would
  // land on the paper.
  it('fits the diagram into view and then opens the print dialog', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    // Run synchronously rather than on a real frame, so the effect's whole sequence is
    // observable without waiting on the browser's own scheduling.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });

    respondWithDiagram();
    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() => expect(useDiagramStore.getState().diagramId).toBe('d1'));
    mockXyflow.mockFitView.mockClear();

    act(() => useDiagramStore.getState().setPrintMode(true));

    expect(mockXyflow.mockFitView).toHaveBeenCalledWith({ duration: 0 });
    // Not yet: the dialog waits for the browser to paint the fitted viewport first.
    expect(print).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(print).toHaveBeenCalledTimes(1);
  });

  // `afterprint` rather than assuming the dialog succeeded, so a cancelled print returns the
  // editor to normal just as a completed one does.
  it('leaves print mode once the browser reports the dialog closed', async () => {
    await renderPrinting();

    await act(async () => {
      window.dispatchEvent(new Event('afterprint'));
    });

    expect(useDiagramStore.getState().printMode).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('');
    expect(document.body.classList.contains('diagram-editor-print-mode')).toBe(false);
    expect(orientationStyle()).toBeNull();
  });

  // The way out when the browser never fires `afterprint` at all.
  it('offers a visible way back out of print mode', async () => {
    await renderPrinting();

    fireEvent.click(screen.getByRole('button', { name: 'Exit print mode' }));

    expect(useDiagramStore.getState().printMode).toBe(false);
  });

  it('restores the editor when print mode is left', async () => {
    await renderPrinting();

    await act(async () => {
      useDiagramStore.getState().setPrintMode(false);
    });

    expect(screen.getByLabelText('Diagram title')).toBeInTheDocument();
    // React Flow's lower-corner controls are intentionally absent; zoom and fit are provided by
    // the editor toolbar instead.
    expect(screen.queryByTestId('rf-controls')).not.toBeInTheDocument();
    expect(document.documentElement.style.colorScheme).toBe('');
  });

  // Leaving the scheme forced would silently disable the appearance control for the rest of the
  // session.
  it('undoes every document change when unmounted mid-print', async () => {
    respondWithDiagram();
    const { unmount } = await renderLoaded();
    await act(async () => {
      useDiagramStore.getState().setPrintMode(true);
    });

    unmount();

    expect(document.documentElement.style.colorScheme).toBe('');
    expect(document.body.classList.contains('diagram-editor-print-mode')).toBe(false);
    expect(orientationStyle()).toBeNull();
  });

  // The scheme in force before printing is restored, not cleared: a visitor who had chosen dark
  // mode explicitly must still have it afterwards.
  it('restores an explicitly chosen colour scheme rather than clearing it', async () => {
    document.documentElement.style.colorScheme = 'dark';
    await renderPrinting();

    expect(document.documentElement.style.colorScheme).toBe('light');

    await act(async () => {
      useDiagramStore.getState().setPrintMode(false);
    });

    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  // Available to an anonymous share viewer too: printing reads a diagram, it does not change it.
  it('works the same way in the read-only posture', async () => {
    render(
      <DiagramCanvas
        diagramId="shared-1"
        readOnly
        initialDiagram={{
          description: null,
          graphData: EMPTY_GRAPH,
          id: 'shared-1',
          title: 'Shared Diagram'
        }}
      />
    );
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());

    await act(async () => {
      useDiagramStore.getState().setPrintMode(true);
    });

    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(screen.getByRole('heading', { level: 2, name: 'Shared Diagram' })).toBeInTheDocument();
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

describe('live sync', () => {
  /**
   * A graph pushed by an agent: one node that was not on the canvas before.
   */
  const PUSHED_GRAPH = JSON.stringify({
    edges: [],
    nodes: [{ data: { label: 'Queue' }, id: 'pushed', position: { x: 0, y: 0 }, type: 'cf-node' }],
    viewport: { x: 0, y: 0, zoom: 1 }
  });

  /**
   * Delivers a whole-graph `snapshot` frame on the canvas's socket.
   *
   * @param updatedAt Server timestamp the snapshot carries.
   * @param graphData Graph JSON the snapshot carries.
   * @param origin Who produced it, or `null` for a connect/resync answer that announces nothing.
   * @returns A promise fulfilled once React has processed the resulting state change.
   */
  async function pushSnapshot(
    updatedAt: string,
    graphData: string = PUSHED_GRAPH,
    origin: 'human' | 'agent' | null = 'agent'
  ): Promise<void> {
    await act(async () => {
      mostRecentSocket().simulateMessage({
        actor: origin === null ? null : 'alice@example.com',
        graphData,
        origin,
        sequence: 1,
        type: 'snapshot',
        updatedAt
      });
    });
  }

  /**
   * Delivers an `operation_applied` frame on the canvas's socket.
   *
   * @param operation The change the frame announces.
   * @param sequence Position in the session's operation stream.
   * @param origin Whether a person or an agent made it.
   * @param updatedAt Server timestamp the frame carries.
   * @returns A promise fulfilled once React has processed the resulting state change.
   */
  async function pushOperation(
    operation: Record<string, unknown>,
    sequence: number,
    origin: 'human' | 'agent' = 'agent',
    updatedAt = '2026-02-01T00:00:00.000Z'
  ): Promise<void> {
    await act(async () => {
      mostRecentSocket().simulateMessage({
        actor: 'alice@example.com',
        operation,
        operationId: null,
        origin,
        sequence,
        type: 'operation_applied',
        updatedAt
      });
    });
  }

  it('opens one socket for the loaded diagram on mount', async () => {
    respondWithDiagram();

    await renderLoaded();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(mostRecentSocket().url).toBe('ws://localhost/api/diagrams/d1/live');
  });

  // Receiving somebody else's change must not create an outbound write of its own. The socket sends
  // only changes this tab originated and a resync when it can no longer apply operations safely.
  it('sends nothing in response to an ordinary change', async () => {
    respondWithDiagram();
    await renderLoaded();

    await pushSnapshot('2026-02-01T00:00:00.000Z');
    await pushOperation({ kind: 'remove_node', nodeId: 'pushed' }, 2);

    expect(mostRecentSocket().sent).toEqual([]);
  });

  it('closes the socket and detaches its handler on unmount', async () => {
    respondWithDiagram();
    const view = await renderLoaded();
    const socket = mostRecentSocket();

    view.unmount();

    expect(socket.closedByClient).toBe(true);
    expect(socket.hasMessageListener()).toBe(false);
  });

  // An anonymous share viewer has no Access session, so the upgrade would be refused — a failed
  // connection in a posture never meant to have one would be pure noise.
  it('opens no socket in the read-only share posture', async () => {
    render(
      <DiagramCanvas
        diagramId="d1"
        readOnly
        initialDiagram={{ description: null, graphData: EMPTY_GRAPH, id: 'd1', title: 'Shared' }}
      />
    );
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('replaces the canvas when a whole-graph snapshot arrives', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();

    await pushSnapshot('2026-02-01T00:00:00.000Z');

    expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['pushed']);
  });

  // The finer frame, and the one the channel normally carries: it changes the element named and
  // leaves the rest of the canvas — including anything this visitor is in the middle of — alone.
  it('applies an operation another editor performed', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    await pushSnapshot('2026-02-01T00:00:00.000Z');

    await pushOperation(
      {
        input: { id: 'added', label: 'Cache', position: { x: 0, y: 9 }, typeId: 'kv' },
        kind: 'add_node'
      },
      2,
      'human'
    );

    expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['pushed', 'added']);
  });

  // A person's change and an agent's need different wording, and the identity cannot tell them
  // apart — an agent authenticates as whoever configured it.
  it.each([
    ['agent', 'Updated by an agent'],
    ['human', 'Updated by another editor']
  ])('names a %s change in the notice', async (origin, expected) => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    // First snapshot establishes the connection's baseline. The second is the actual remote update
    // this case is naming.
    await pushSnapshot('2026-02-01T00:00:00.000Z', EMPTY_GRAPH, null);
    await pushSnapshot('2026-03-01T00:00:00.000Z', PUSHED_GRAPH, origin as 'human' | 'agent');

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  // The snapshot a joining tab is sent on connect establishes the stream baseline. It is silent
  // even when a write landed in the narrow HTTP-read-to-WebSocket-upgrade gap and the session
  // attributes that newer graph: the visitor has not seen a prior canvas state, so "another
  // editor" is a false story — particularly visible after creating a blueprint, whose creator is
  // the only person involved.
  it.each([null, 'human', 'agent'] as const)(
    'shows no notice for its initial %s-attributed snapshot',
    async (origin) => {
      respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
      await renderLoaded();

      await pushSnapshot('2026-02-01T00:00:00.000Z', PUSHED_GRAPH, origin);

      expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['pushed']);
      expect(screen.queryByText('Updated by an agent')).not.toBeInTheDocument();
      expect(screen.queryByText('Updated by another editor')).not.toBeInTheDocument();
    }
  );

  it('automatically dismisses a genuine remote-update notice', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    // First snapshot establishes the baseline. The second one is a real later broadcast.
    await pushSnapshot('2026-02-01T00:00:00.000Z', PUSHED_GRAPH, null);
    await pushSnapshot('2026-03-01T00:00:00.000Z', EMPTY_GRAPH, 'human');

    expect(screen.getByText('Updated by another editor')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(screen.queryByText('Updated by another editor')).not.toBeInTheDocument();
  });

  it('restarts the dismissal timer when a newer change replaces the notice', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await pushSnapshot('2026-02-01T00:00:00.000Z', PUSHED_GRAPH, null);
    await pushSnapshot('2026-03-01T00:00:00.000Z', EMPTY_GRAPH, 'human');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await pushSnapshot('2026-04-01T00:00:00.000Z', PUSHED_GRAPH, 'agent');

    // The original timer would have expired now, but the newer agent notice owns a fresh window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText('Updated by an agent')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByText('Updated by an agent')).not.toBeInTheDocument();
  });

  // Operation-based sync diverges silently when a frame is missed: the operation after the gap
  // may name an element that no longer means what it did. The tab says so rather than guessing.
  it('asks for a fresh snapshot when it has missed a frame, and applies nothing', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    await pushSnapshot('2026-02-01T00:00:00.000Z');

    await pushOperation({ kind: 'remove_node', nodeId: 'pushed' }, 9);

    expect(mostRecentSocket().sent).toEqual([JSON.stringify({ type: 'resync' })]);
    // The canvas is untouched: applying the operation is exactly what would have diverged.
    expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['pushed']);
  });

  // An operation the server applied but this tab cannot means the two have already diverged,
  // which has the same remedy as a missed frame.
  it('asks for a fresh snapshot when an operation cannot be applied', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    await pushSnapshot('2026-02-01T00:00:00.000Z');

    await pushOperation({ kind: 'remove_node', nodeId: 'never-existed' }, 2);

    expect(mostRecentSocket().sent).toEqual([JSON.stringify({ type: 'resync' })]);
  });

  // The echo of this tab's own operation. Applying it twice would duplicate a node, and
  // announcing it would tell the visitor about their own edit.
  it('ignores an operation it has already applied, and announces nothing', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    // A connect snapshot, which announces nothing — so the only thing that could raise a notice
    // below is the duplicate operation itself.
    await pushSnapshot('2026-02-01T00:00:00.000Z', PUSHED_GRAPH, null);

    await pushOperation({ kind: 'remove_node', nodeId: 'pushed' }, 1);

    expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['pushed']);
    expect(screen.queryByText('Updated by an agent')).not.toBeInTheDocument();
    expect(mostRecentSocket().sent).toEqual([]);
  });

  // A rejection is addressed to the connection that sent the operation, and this tab does not
  // send any yet — but the protocol permits it, so receiving one must not break the editor.
  it('tolerates a rejection frame without disturbing the canvas', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    await pushSnapshot('2026-02-01T00:00:00.000Z');

    await act(async () => {
      mostRecentSocket().simulateMessage({
        detail: 'Node "ghost" not found.',
        operationId: 'not-ours',
        status: 404,
        type: 'operation_rejected'
      });
    });

    expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['pushed']);
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });

  // The canvas must not change under the visitor with no explanation; that reads as a bug rather
  // than as the feature it is.
  it('explains the change with a dismissible notice', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();

    await pushSnapshot('2026-02-01T00:00:00.000Z', EMPTY_GRAPH, null);
    await pushSnapshot('2026-03-01T00:00:00.000Z');
    const notice = screen.getByText('Updated by an agent');
    // An `<output>`, which carries the `status` role natively, so the notice is announced without
    // stealing focus — the change is informational, and taking focus would interrupt whatever the
    // visitor was doing. Found by its text rather than by role alone, because the status bar is a
    // `status` region too and a role query would match both.
    const region = notice.closest('output');
    expect(region).not.toBeNull();
    expect(screen.getAllByRole('status')).toContain(region);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));

    expect(screen.queryByText('Updated by an agent')).not.toBeInTheDocument();
  });

  it('shows no notice before anything has been pushed', async () => {
    respondWithDiagram();

    await renderLoaded();

    expect(screen.queryByText('Updated by an agent')).not.toBeInTheDocument();
  });

  // A push that lost a race describes a version this tab has already moved past. Applying it
  // would revert the canvas under the visitor, and announcing it would explain a change that did
  // not happen.
  it.each([
    ['older', '2025-01-01T00:00:00.000Z'],
    ['identical', '2026-01-01T00:00:00.000Z']
  ])('discards an %s push and shows no notice', async (_label, updatedAt) => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();

    await pushSnapshot(updatedAt);

    expect(useDiagramStore.getState().nodes).toEqual([]);
    expect(screen.queryByText('Updated by an agent')).not.toBeInTheDocument();
  });

  // The save records the server's own timestamp, which is what a later push is compared against.
  it('discards a push older than the tab’s own most recent save', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    act(() => {
      useDiagramStore.getState().markSaved('2026-03-01T00:00:00.000Z');
    });

    await pushSnapshot('2026-02-01T00:00:00.000Z');

    expect(useDiagramStore.getState().nodes).toEqual([]);
  });

  it('leaves a pending local change pending rather than marking it saved', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    act(() => {
      useDiagramStore.setState({ dirty: true });
    });

    await pushSnapshot('2026-02-01T00:00:00.000Z');

    expect(useDiagramStore.getState().dirty).toBe(true);
  });

  // A frame the canvas cannot act on must not break a working editor: the visitor's diagram is
  // intact and their own saves are unaffected, so there is nothing useful to report.
  it.each([
    ['malformed JSON', 'not json'],
    ['an acknowledgement', JSON.stringify({ type: 'connected', viewer: 'alice@example.com' })],
    ['a server error frame', JSON.stringify({ detail: 'read-only', type: 'error' })]
  ])('ignores %s without disturbing the canvas', async (_label, payload) => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();

    await act(async () => {
      mostRecentSocket().simulateMessage(payload);
    });

    expect(useDiagramStore.getState().nodes).toEqual([]);
    expect(screen.queryByText('Updated by an agent')).not.toBeInTheDocument();
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });

  it('hides the notice in print mode along with every other piece of chrome', async () => {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    await renderLoaded();
    await pushSnapshot('2026-02-01T00:00:00.000Z');

    act(() => {
      useDiagramStore.getState().setPrintMode(true);
    });

    expect(screen.queryByText('Updated by an agent')).not.toBeInTheDocument();
  });
});

describe('the assistant conversation', () => {
  /**
   * A one-node graph, so a removal has something to remove and a narration has a label to read.
   */
  const ONE_NODE_GRAPH = JSON.stringify({
    edges: [],
    nodes: [{ data: { label: 'Queue' }, id: 'pushed', position: { x: 0, y: 0 }, type: 'cf-node' }],
    viewport: { x: 0, y: 0, zoom: 1 }
  });

  /**
   * Delivers a `snapshot` frame, which is what gives this tab a confirmed base to apply the
   * assistant's operations to.
   *
   * @param updatedAt Server timestamp the snapshot carries.
   * @param graphData Graph JSON it carries.
   * @param origin Who produced it, or `null` for a connect answer that announces nothing.
   * @returns A promise fulfilled once React has processed it.
   */
  async function pushBaseSnapshot(
    updatedAt: string,
    graphData: string = EMPTY_GRAPH,
    origin: 'human' | 'agent' | null = null
  ): Promise<void> {
    await act(async () => {
      mostRecentSocket().simulateMessage({
        actor: origin === null ? null : 'alice@example.com',
        graphData,
        origin,
        sequence: 1,
        type: 'snapshot',
        updatedAt
      });
    });
  }

  /**
   * Opens the assistant tab on a loaded canvas.
   *
   * @returns Nothing.
   */
  function openAssistant(): void {
    act(() => {
      useDiagramStore.getState().setDetailsPanelTab('ai-chat');
      useDiagramStore.setState({ propertiesOpen: true });
    });
  }

  /**
   * Loads the canvas with the assistant tab showing.
   *
   * @returns The render result.
   */
  async function renderWithAssistant() {
    respondWithDiagram({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const view = await renderLoaded();
    openAssistant();
    return view;
  }

  /**
   * Delivers one frame and lets React process it.
   *
   * @param frame The frame to deliver.
   * @returns A promise fulfilled once the resulting state change has been applied.
   */
  async function deliver(frame: Record<string, unknown>): Promise<void> {
    await act(async () => {
      mostRecentSocket().simulateMessage(frame);
    });
  }

  /**
   * Delivers several frames inside **one** React batch, as a burst arriving in one task does.
   *
   * @param frames The frames to deliver, in order.
   * @returns A promise fulfilled once the batch has been rendered.
   */
  async function deliverTogether(frames: Record<string, unknown>[]): Promise<void> {
    await act(async () => {
      for (const frame of frames) {
        mostRecentSocket().simulateMessage(frame);
      }
    });
  }

  /**
   * Types a message into the composer and sends it.
   *
   * @param text The message to send.
   * @returns A promise fulfilled once the send has been processed.
   */
  async function sendMessage(text: string): Promise<void> {
    fireEvent.change(screen.getByLabelText('Message the AI assistant'), {
      target: { value: text }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    });
  }

  /**
   * Reads the transcript as the ordered list of lines a reader would see.
   *
   * @returns Each entry's text content, in document order.
   */
  function transcriptLines(): string[] {
    return [...screen.getByRole('log').children].map((entry) => entry.textContent ?? '');
  }

  /**
   * An `operation_applied` frame the assistant produced.
   *
   * @param operation The change it announces.
   * @param sequence Position in the session's operation stream.
   * @returns The frame.
   */
  function aiOperation(operation: Record<string, unknown>, sequence: number) {
    return {
      actor: 'alice@example.com',
      operation,
      operationId: null,
      origin: 'ai-chat',
      sequence,
      type: 'operation_applied',
      updatedAt: '2026-02-01T00:00:00.000Z'
    };
  }

  it('sends the typed message over the diagram’s own socket, with no author field', async () => {
    await renderWithAssistant();

    await sendMessage('Add a Worker');

    const sent = mostRecentSocket().sent.map(
      (payload) => JSON.parse(payload) as Record<string, unknown>
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: 'Add a Worker', type: 'chat_message' });
    expect(sent[0]).toHaveProperty('clientRequestId');
    // The session attributes the turn to the identity pinned to the socket, so a frame naming an
    // actor would be a field it must refuse. It must not be sent in the first place.
    expect(sent[0]).not.toHaveProperty('actor');
    expect(screen.getByText('Add a Worker')).toBeInTheDocument();
  });

  it('refuses to send while the socket is closed, keeping the draft', async () => {
    await renderWithAssistant();
    act(() => {
      mostRecentSocket().simulateServerClose();
    });

    await sendMessage('Add a Worker');

    expect(mostRecentSocket().sent).toEqual([]);
    expect(screen.getByLabelText('Message the AI assistant')).toHaveValue('Add a Worker');
  });

  it('renders status, documentation and streamed answer frames', async () => {
    await renderWithAssistant();
    await sendMessage('What is Workers AI?');
    const clientRequestId = (
      JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
    ).clientRequestId;

    await deliver({ clientRequestId, message: 'Checking Cloudflare docs…', type: 'chat_status' });
    await deliver({
      clientRequestId,
      outcome: {
        ok: true,
        results: [{ snippet: '…', title: 'Workers AI', url: 'https://example.test/ai' }]
      },
      query: 'Workers AI',
      tool: 'search_cloudflare_documentation',
      type: 'chat_tool_result'
    });
    await deliver({ clientRequestId, text: 'It runs ', type: 'chat_token' });
    await deliver({ clientRequestId, text: 'models at the edge.', type: 'chat_token' });
    await deliver({
      assistantText: 'It runs models at the edge.',
      clientRequestId,
      type: 'chat_done'
    });

    expect(screen.getByText('Checking Cloudflare docs…')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workers AI' })).toBeInTheDocument();
    // Accumulated rather than replaced: the two fragments are one answer.
    expect(screen.getByText('It runs models at the edge.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('reports a failed turn and leaves the composer usable', async () => {
    await renderWithAssistant();
    await sendMessage('Explain this diagram');
    const clientRequestId = (
      JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
    ).clientRequestId;

    await deliver({ clientRequestId, message: 'Gateway unavailable.', type: 'chat_error' });

    expect(screen.getByText('Gateway unavailable.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message the AI assistant'), {
      target: { value: 'Try again' }
    });
    expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();
  });

  it('stops watching a turn without claiming the model was cancelled', async () => {
    await renderWithAssistant();
    await sendMessage('Explain this diagram');
    const clientRequestId = (
      JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
    ).clientRequestId;
    await deliver({ clientRequestId, text: 'Partial answer', type: 'chat_token' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    });

    expect(screen.getByText(/may still be working in the background/)).toBeInTheDocument();

    // The turn keeps running server-side: its remaining frames must change nothing on screen.
    await deliver({ clientRequestId, text: ' continues', type: 'chat_token' });
    await deliver({
      assistantText: 'Partial answer continues',
      clientRequestId,
      type: 'chat_done'
    });

    expect(screen.getByText('Partial answer')).toBeInTheDocument();
    expect(screen.queryByText('Partial answer continues')).not.toBeInTheDocument();
  });

  // Two presses land in one batch before the control is withdrawn, so the second one finds no
  // turn to stop. It must be a no-op rather than marking a second bubble or clearing the next
  // turn's state.
  it('ignores a second Stop press in the same batch', async () => {
    await renderWithAssistant();
    await sendMessage('Explain this diagram');
    const clientRequestId = (
      JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
    ).clientRequestId;
    await deliver({ clientRequestId, text: 'Partial answer', type: 'chat_token' });

    const stop = screen.getByRole('button', { name: /Stop/ });
    await act(async () => {
      fireEvent.click(stop);
      fireEvent.click(stop);
    });

    expect(screen.getAllByText(/may still be working in the background/)).toHaveLength(1);
  });

  it('consumes a stopped turn’s failure silently rather than reporting it twice', async () => {
    await renderWithAssistant();
    await sendMessage('Explain this diagram');
    const clientRequestId = (
      JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
    ).clientRequestId;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    });

    await deliver({ clientRequestId, message: 'Gateway unavailable.', type: 'chat_error' });

    expect(screen.queryByText('Gateway unavailable.')).not.toBeInTheDocument();
  });

  it('clears only the local transcript for a new conversation', async () => {
    await renderWithAssistant();
    await sendMessage('Add a Worker');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    });

    expect(screen.queryByText('Add a Worker')).not.toBeInTheDocument();
    expect(screen.getByText(/Ask the assistant to add nodes/)).toBeInTheDocument();
    // No frame is sent: nothing in this protocol can reset the session's own history, and closing
    // the socket to achieve it would discard this tab's presence and pending operations too.
    expect(mostRecentSocket().sent).toHaveLength(1);
  });

  it('applies a renamed diagram without marking it dirty', async () => {
    await renderWithAssistant();

    await deliver({ description: 'An AI design.', title: 'AI design', type: 'diagram_renamed' });

    expect(useDiagramStore.getState().title).toBe('AI design');
    expect(useDiagramStore.getState().description).toBe('An AI design.');
    expect(useDiagramStore.getState().dirty).toBe(false);
  });

  it('normalises a cleared description on a rename', async () => {
    await renderWithAssistant();

    await deliver({ description: null, title: 'AI design', type: 'diagram_renamed' });

    expect(useDiagramStore.getState().description).toBe('');
  });

  // Regression (1 of 3). The narration of a graph change comes from the **confirmed**
  // `operation_applied` broadcast and nowhere else. A status frame is necessarily emitted before
  // the operation is applied, so narrating from one would both double every line and announce
  // changes the session then rejected — which is exactly what made a transcript claim edges had
  // been connected when they had not. Narrating from the status frame fails this test twice: the
  // rejected turn would produce a line, and the applied one would produce two.
  it('narrates a mutation exactly once, and only once it is confirmed', async () => {
    await renderWithAssistant();
    await pushBaseSnapshot('2026-02-01T00:00:00.000Z');
    await sendMessage('Add a Worker and a cache');
    const clientRequestId = (
      JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
    ).clientRequestId;

    // The turn the session refused: it reports the rejection to the model as a tool result and
    // broadcasts nothing, so the only frames this tab sees are the turn's own narration.
    await deliver({ clientRequestId, message: 'Working on it…', type: 'chat_status' });
    await deliver({
      assistantText: 'That node already exists.',
      clientRequestId,
      type: 'chat_done'
    });

    expect(screen.queryByText(/^Added node:/)).not.toBeInTheDocument();

    // The turn the session applied.
    await sendMessage('Add a Worker');
    await deliver(
      aiOperation(
        {
          input: { id: 'api', label: 'API', position: { x: 0, y: 0 }, typeId: 'worker' },
          kind: 'add_node'
        },
        2
      )
    );

    expect(screen.getAllByText('Added node: API')).toHaveLength(1);
    expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['api']);
  });

  // Regression (2 of 3). A bubble anchored where its first token landed goes on collecting the
  // turn's later prose, so a turn that narrates, acts, then narrates again puts its closing
  // summary *above* the action it followed. Appending any non-assistant entry must therefore
  // clear the anchor. Without that, the last assertion below finds 'Here is the plan:Done.' in
  // position 1 and the action line after it.
  it('reads chronologically when a turn narrates, acts, then narrates again', async () => {
    await renderWithAssistant();
    await pushBaseSnapshot('2026-02-01T00:00:00.000Z');
    await sendMessage('Design something');
    const clientRequestId = (
      JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
    ).clientRequestId;

    await deliver({ clientRequestId, text: 'Here is the plan:', type: 'chat_token' });
    await deliver(
      aiOperation(
        {
          input: { id: 'api', label: 'API', position: { x: 0, y: 0 }, typeId: 'worker' },
          kind: 'add_node'
        },
        2
      )
    );
    await deliver({ clientRequestId, text: 'Done.', type: 'chat_token' });
    await deliver({ assistantText: 'Here is the plan:Done.', clientRequestId, type: 'chat_done' });

    expect(transcriptLines()).toEqual([
      'Design something',
      'Here is the plan:',
      'Added node: API',
      'Done.'
    ]);
  });

  // Regression (3 of 3). The last token of a turn and the `chat_done` that follows it routinely
  // arrive in one task and therefore render in one batch. Resolving the bubble id or reading the
  // "did anything stream?" ref *inside* a deferred `setState` updater means neither handler
  // observes what it saw itself, and the answer appears twice. Every id and ref here is resolved
  // synchronously, outside the updater, and `chat_done` records the answer only when nothing
  // streamed — because a turn may own several bubbles and rewriting "the" bubble with the whole
  // answer would duplicate every earlier one's prose into the last.
  it('produces one bubble when a token and its completion render in the same batch', async () => {
    await renderWithAssistant();
    await sendMessage('Explain this diagram');
    const clientRequestId = (
      JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
    ).clientRequestId;

    await deliverTogether([
      { clientRequestId, text: 'One answer.', type: 'chat_token' },
      { assistantText: 'One answer.', clientRequestId, type: 'chat_done' }
    ]);

    expect(screen.getAllByText('One answer.')).toHaveLength(1);
    expect(transcriptLines()).toEqual(['Explain this diagram', 'One answer.']);
  });

  // The other half of the same rule: with nothing streamed there is no bubble, so the completion
  // frame's own copy of the answer is the only one there is.
  it('records the answer when a turn completes without streaming anything', async () => {
    await renderWithAssistant();
    await sendMessage('Explain this diagram');
    const clientRequestId = (
      JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
    ).clientRequestId;

    await deliver({ assistantText: 'A short answer.', clientRequestId, type: 'chat_done' });

    expect(transcriptLines()).toEqual(['Explain this diagram', 'A short answer.']);
  });

  it('suppresses the remote-change notice for the tab that is chatting', async () => {
    await renderWithAssistant();
    await pushBaseSnapshot('2026-02-01T00:00:00.000Z');
    await sendMessage('Add a Worker');

    await deliver(
      aiOperation(
        {
          input: { id: 'api', label: 'API', position: { x: 0, y: 0 }, typeId: 'worker' },
          kind: 'add_node'
        },
        2
      )
    );

    expect(screen.queryByText('Updated by another editor')).not.toBeInTheDocument();
    expect(screen.getByText('Added node: API')).toBeInTheDocument();
  });

  // A passive collaborator's tab has no turn in flight, so it is told — exactly as it would be
  // for a person's edit — that the canvas changed under it.
  it('shows the notice to a tab that is not chatting', async () => {
    await renderWithAssistant();
    await pushBaseSnapshot('2026-02-01T00:00:00.000Z');

    await deliver(
      aiOperation(
        {
          input: { id: 'api', label: 'API', position: { x: 0, y: 0 }, typeId: 'worker' },
          kind: 'add_node'
        },
        2
      )
    );

    expect(screen.getByText('Updated by another editor')).toBeInTheDocument();
  });

  it('starts a fresh transcript when the editor opens a different diagram', async () => {
    const view = await renderWithAssistant();
    await sendMessage('Add a Worker');

    respondWithDiagram({ id: 'd2', updatedAt: '2026-01-01T00:00:00.000Z' });
    view.rerender(<DiagramCanvas diagramId="d2" />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    openAssistant();

    expect(screen.queryByText('Add a Worker')).not.toBeInTheDocument();
  });

  describe('the post-turn layout pass', () => {
    /**
     * Drives one turn that adds a node and completes.
     *
     * @param lastFrame The frame that ends the turn.
     * @returns A promise fulfilled once the turn's frames have been processed.
     */
    async function runNodeAddingTurn(lastFrame: 'chat_done' | 'chat_error'): Promise<void> {
      await pushBaseSnapshot('2026-02-01T00:00:00.000Z');
      await sendMessage('Add a Worker');
      const clientRequestId = (
        JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
      ).clientRequestId;

      await deliver(
        aiOperation(
          {
            input: { id: 'api', label: 'API', position: { x: 0, y: 0 }, typeId: 'worker' },
            kind: 'add_node'
          },
          2
        )
      );
      await deliver(
        lastFrame === 'chat_done'
          ? { assistantText: 'Done.', clientRequestId, type: 'chat_done' }
          : { clientRequestId, message: 'Gateway unavailable.', type: 'chat_error' }
      );
    }

    it('runs once and persists the result through the existing whole-graph route', async () => {
      mockElkLayout.mockResolvedValue({ children: [{ id: 'api', x: 48, y: 96 }] });
      await renderWithAssistant();

      await runNodeAddingTurn('chat_done');
      await waitFor(() => expect(mockSaveDiagramGraph).toHaveBeenCalledTimes(1));

      expect(mockElkLayout).toHaveBeenCalledTimes(1);
      expect(useDiagramStore.getState().nodes[0]?.position).toEqual({ x: 48, y: 96 });
      const [diagramId, graphData] = mockSaveDiagramGraph.mock.calls[0] as [string, string];
      expect(diagramId).toBe('d1');
      expect(
        (JSON.parse(graphData) as { nodes: { position: unknown }[] }).nodes[0]?.position
      ).toEqual({ x: 48, y: 96 });
      // No new frame and no new endpoint: the layout travels on the route the autosave already
      // uses, which reaches the same session object.
      expect(mostRecentSocket().sent).toHaveLength(1);
    });

    // A failed turn keeps whatever it already applied — each operation was persisted and
    // broadcast on its own — so the nodes it added still deserve their one pass.
    it('runs after a failed turn that had already added a node', async () => {
      mockElkLayout.mockResolvedValue({ children: [{ id: 'api', x: 48, y: 96 }] });
      await renderWithAssistant();

      await runNodeAddingTurn('chat_error');

      await waitFor(() => expect(mockElkLayout).toHaveBeenCalledTimes(1));
    });

    it('does not run for a turn that changed no node count', async () => {
      await renderWithAssistant();
      await pushBaseSnapshot('2026-02-01T00:00:00.000Z', ONE_NODE_GRAPH);
      await sendMessage('Rename the cache');
      const clientRequestId = (
        JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
      ).clientRequestId;

      await deliver(
        aiOperation({ kind: 'update_node', nodeId: 'pushed', patch: { label: 'Cache' } }, 2)
      );
      await deliver({ assistantText: 'Renamed.', clientRequestId, type: 'chat_done' });

      expect(mockElkLayout).not.toHaveBeenCalled();
      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
    });

    it('does nothing on an empty canvas', async () => {
      await renderWithAssistant();
      await pushBaseSnapshot('2026-02-01T00:00:00.000Z', ONE_NODE_GRAPH);
      await sendMessage('Remove everything');
      const clientRequestId = (
        JSON.parse(mostRecentSocket().sent[0] as string) as { clientRequestId: string }
      ).clientRequestId;

      await deliver(aiOperation({ kind: 'remove_node', nodeId: 'pushed' }, 2));
      await deliver({ assistantText: 'Removed.', clientRequestId, type: 'chat_done' });

      expect(screen.getByText('Removed node: Queue')).toBeInTheDocument();
      expect(mockElkLayout).not.toHaveBeenCalled();
    });

    // The conversation's own changes are already persisted; only the tidying failed, so the
    // diagram is still usable and there is nothing worth interrupting the reader about.
    it('absorbs a failed layout without disturbing the diagram', async () => {
      mockElkLayout.mockRejectedValue(new Error('offline'));
      await renderWithAssistant();

      await runNodeAddingTurn('chat_done');

      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
      expect(useDiagramStore.getState().nodes.map((node) => node.id)).toEqual(['api']);
    });

    it('leaves the canvas alone when the engine computed nothing', async () => {
      mockElkLayout.mockResolvedValue({});
      await renderWithAssistant();

      await runNodeAddingTurn('chat_done');

      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
      expect(useDiagramStore.getState().nodes[0]?.position).toEqual({ x: 0, y: 0 });
    });

    // The whole-graph write is echoed back to its own author, so without the in-flight guard the
    // visitor would be told another editor had rearranged the diagram they just tidied.
    it('does not announce its own write as somebody else’s change', async () => {
      mockElkLayout.mockResolvedValue({ children: [{ id: 'api', x: 48, y: 96 }] });
      let resolveSave: (updatedAt: string) => void = () => {};
      mockSaveDiagramGraph.mockImplementation(
        async () => new Promise<string>((resolve) => (resolveSave = resolve))
      );
      await renderWithAssistant();

      await runNodeAddingTurn('chat_done');
      await waitFor(() => expect(mockSaveDiagramGraph).toHaveBeenCalledTimes(1));
      await pushBaseSnapshot('2026-03-01T00:00:00.000Z', ONE_NODE_GRAPH, 'human');

      expect(screen.queryByText('Updated by another editor')).not.toBeInTheDocument();

      await act(async () => {
        resolveSave('2026-03-01T00:00:00.000Z');
      });
    });
  });
});
