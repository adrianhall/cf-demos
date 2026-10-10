import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockGetDiagram, mockSaveDiagramGraph, mockUpdateDiagram } = vi.hoisted(
  () => ({
    mockGetDiagram: vi.fn(),
    mockSaveDiagramGraph: vi.fn(),
    mockUpdateDiagram: vi.fn(),
  }),
);
vi.mock("../../api/diagrams", () => ({
  getDiagram: mockGetDiagram,
  saveDiagramGraph: mockSaveDiagramGraph,
  updateDiagram: mockUpdateDiagram,
}));

// Defaults every test to `connected: false` -- the same behavior as before this hook existed,
// since the real hook's socket never opens in this jsdom test environment anyway. A dedicated
// describe block below overrides this to `connected: true` to exercise the live-socket flush
// branch of the debounced autosave effect.
const {
  mockUseDiagramLiveSync,
  mockSendOperation,
  mockSendCursor,
  mockSendSelectionChange,
  mockSendChatMessage,
  mockStopChatTurn,
  mockClearChatTranscript,
} = vi.hoisted(() => ({
  mockClearChatTranscript: vi.fn(),
  mockSendChatMessage: vi.fn(() => false),
  mockSendCursor: vi.fn(),
  mockSendOperation: vi.fn(() => false),
  mockSendSelectionChange: vi.fn(),
  mockStopChatTurn: vi.fn(),
  mockUseDiagramLiveSync: vi.fn(),
}));
mockUseDiagramLiveSync.mockImplementation(() => ({
  chatInFlight: false,
  chatTranscript: [],
  clearChatTranscript: mockClearChatTranscript,
  connected: false,
  cursors: {},
  participants: {},
  remoteSelections: {},
  sendChatMessage: mockSendChatMessage,
  sendCursor: mockSendCursor,
  sendOperation: mockSendOperation,
  sendSelectionChange: mockSendSelectionChange,
  stopChatTurn: mockStopChatTurn,
}));
vi.mock("../../hooks/useDiagramLiveSync", () => ({
  useDiagramLiveSync: mockUseDiagramLiveSync,
}));

// Wraps the real `ServicePalette` (every other test in this file exercises it unmodified) so one
// dedicated test below can override its implementation to call `onAddNode` with a typeId the
// catalog does not recognize -- something the real palette itself never does, since it only ever
// lists actual catalog entries -- to exercise `onAddNodeFromPalette`'s defensive guard.
vi.mock("./panels/ServicePalette", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./panels/ServicePalette")>();
  return { ...actual, ServicePalette: vi.fn(actual.ServicePalette) };
});

const { useDiagramStore } = await import("../../stores/diagramStore");
const { DiagramCanvas } = await import("./DiagramCanvas");
const { ServicePalette } = await import("./panels/ServicePalette");

const EMPTY_GRAPH = JSON.stringify({
  edges: [],
  nodes: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});

describe("DiagramCanvas", () => {
  beforeEach(() => {
    useDiagramStore.setState({
      diagramId: null,
      title: "Untitled Diagram",
      description: "",
      nodes: [],
      edges: [],
      pendingOperations: new Map(),
      dirty: false,
      saving: false,
      saveError: null,
      lastSavedAt: null,
      printMode: false,
      paletteOpen: true,
      propertiesOpen: false,
      minimapOpen: true,
      detailsPanelTab: "properties",
      detailsPanelExpanded: false,
      undoStack: [],
      redoStack: [],
    });
    mockGetDiagram.mockReset();
    mockSaveDiagramGraph
      .mockReset()
      .mockResolvedValue("2026-01-01T00:00:00.000Z");
    mockUpdateDiagram.mockReset().mockResolvedValue({});
    mockSendOperation.mockReset().mockReturnValue(false);
    mockSendCursor.mockReset();
    mockSendSelectionChange.mockReset();
    mockSendChatMessage.mockReset().mockReturnValue(false);
    mockStopChatTurn.mockReset();
    mockClearChatTranscript.mockReset();
    mockUseDiagramLiveSync.mockReset().mockImplementation(() => ({
      chatInFlight: false,
      chatTranscript: [],
      clearChatTranscript: mockClearChatTranscript,
      connected: false,
      cursors: {},
      participants: {},
      remoteSelections: {},
      sendChatMessage: mockSendChatMessage,
      sendCursor: mockSendCursor,
      sendOperation: mockSendOperation,
      sendSelectionChange: mockSendSelectionChange,
      stopChatTurn: mockStopChatTurn,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a loading state before the diagram fetch resolves", () => {
    mockGetDiagram.mockReturnValue(new Promise(() => {}));
    render(<DiagramCanvas diagramId="d1" />);
    expect(screen.getByText("Loading diagram…")).toBeInTheDocument();
  });

  it("loads the diagram and renders the editor once resolved", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Diagram title")).toHaveValue("My Diagram");
  });

  it("fits the view once nodes finish initializing after loading a diagram (Bug 29)", async () => {
    mockXyflow.mockUseNodesInitialized.mockReturnValue(false);
    mockXyflow.mockFitView.mockClear();
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    const { rerender } = render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    // `CFNode`'s custom renderer has no explicit size, so the diagram's real dimensions aren't
    // known until `useNodesInitialized()` flips to `true` -- no fit should happen before then.
    expect(mockXyflow.mockFitView).not.toHaveBeenCalled();

    mockXyflow.mockUseNodesInitialized.mockReturnValue(true);
    rerender(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(mockXyflow.mockFitView).toHaveBeenCalledWith({ duration: 0 }),
    );
  });

  it("fits the view only once per mount, not on every render after nodes are initialized (Bug 29)", async () => {
    mockXyflow.mockUseNodesInitialized.mockReturnValue(true);
    mockXyflow.mockFitView.mockClear();
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    const { rerender } = render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(mockXyflow.mockFitView).toHaveBeenCalledTimes(1),
    );

    rerender(<DiagramCanvas diagramId="d1" />);
    rerender(<DiagramCanvas diagramId="d1" />);

    // A user's own subsequent pan/zoom must never be fought by a repeated auto-fit.
    expect(mockXyflow.mockFitView).toHaveBeenCalledTimes(1);
  });

  it("hides the service palette when paletteOpen is false (Bug 4)", async () => {
    useDiagramStore.setState({ paletteOpen: false });
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Service palette")).not.toBeInTheDocument();
  });

  it("renders the minimap by default", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(screen.getByTestId("rf-minimap")).toBeInTheDocument(),
    );
  });

  it("hides the minimap when minimapOpen is false", async () => {
    useDiagramStore.setState({ minimapOpen: false });
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("rf-minimap")).not.toBeInTheDocument();
  });

  it("hides the properties panel until propertiesOpen is true (Bug 4)", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    // `role="tabpanel"` is the details panel's own outer content region
    // (`./panels/DetailsPanel.tsx`, docs/09D-ARCHITECT-AICHAT.md) -- its absence/presence is the
    // proxy for "the whole details panel slot is hidden/shown" that `getByLabelText("Properties")`
    // used to be before that region's own `aria-labelledby` made "Properties" itself an
    // ambiguous label (both the tabpanel and `PropertiesPanel`'s own empty-state `<aside>` are
    // now labeled "Properties").
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();

    act(() => useDiagramStore.getState().setSelectedNode("n1"));

    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
    expect(
      screen.getByText("Select a node or edge to view its properties."),
    ).toBeInTheDocument();
  });

  it("tolerates malformed graphData by loading an empty graph", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: "{not json",
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("tolerates an empty graphData string by loading an empty graph", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: "",
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("defaults nodes, edges, and viewport when graphData is valid JSON missing those fields", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: "{}",
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    expect(useDiagramStore.getState().nodes).toEqual([]);
    expect(useDiagramStore.getState().edges).toEqual([]);
    expect(useDiagramStore.getState().viewport).toEqual({
      x: 0,
      y: 0,
      zoom: 1,
    });
  });

  it("defaults a null owner-authenticated description to an empty string", async () => {
    mockGetDiagram.mockResolvedValue({
      description: null,
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);

    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    expect(useDiagramStore.getState().description).toBe("");
  });

  it("shows an error state when the diagram fails to load", async () => {
    mockGetDiagram.mockRejectedValue(new Error("Diagram not found."));

    render(<DiagramCanvas diagramId="missing" />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Diagram not found."),
    );
    expect(
      screen.getByRole("link", { name: "Back to dashboard" }),
    ).toHaveAttribute("href", "/app");
  });

  it("shows a generic message when the load failure is not an Error instance", async () => {
    mockGetDiagram.mockRejectedValue("boom");

    render(<DiagramCanvas diagramId="missing" />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load diagram.",
      ),
    );
  });

  it("ignores a diagram fetch that resolves after the component has unmounted", async () => {
    let resolveGetDiagram!: (value: {
      description: string;
      graphData: string;
      id: string;
      title: string;
    }) => void;
    mockGetDiagram.mockReturnValue(
      new Promise((resolve) => {
        resolveGetDiagram = resolve;
      }),
    );

    const { unmount } = render(<DiagramCanvas diagramId="d1" />);
    unmount();

    // Resolving after unmount (the effect's cleanup already set `cancelled = true`) must not
    // call `setDiagram` on a store no live component reads from anymore.
    resolveGetDiagram({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });
    await Promise.resolve();
    expect(useDiagramStore.getState().diagramId).toBeNull();
  });

  it("ignores a diagram fetch that rejects after the component has unmounted", async () => {
    let rejectGetDiagram!: (reason: unknown) => void;
    mockGetDiagram.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectGetDiagram = reject;
      }),
    );

    const { unmount } = render(<DiagramCanvas diagramId="d1" />);
    unmount();

    rejectGetDiagram(new Error("too late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("autosaves the graph after a debounced change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() =>
      expect(useDiagramStore.getState().diagramId).toBe("d1"),
    );

    useDiagramStore.getState().addNode({
      data: { label: "Workers", typeId: "worker" },
      id: "n1",
      position: { x: 0, y: 0 },
      type: "cf-node",
    });
    expect(useDiagramStore.getState().dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(500);

    expect(mockSaveDiagramGraph).toHaveBeenCalledWith(
      "d1",
      expect.stringContaining("n1"),
    );
    await vi.waitFor(() =>
      expect(useDiagramStore.getState().dirty).toBe(false),
    );
  });

  it("records a save error when autosave fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });
    mockSaveDiagramGraph.mockRejectedValue(new Error("Network error"));

    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() =>
      expect(useDiagramStore.getState().diagramId).toBe("d1"),
    );

    useDiagramStore.getState().addNode({
      data: { label: "Workers", typeId: "worker" },
      id: "n1",
      position: { x: 0, y: 0 },
      type: "cf-node",
    });

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() =>
      expect(useDiagramStore.getState().saveError).toBe("Network error"),
    );
  });

  it("records a generic save error when autosave fails with a non-Error rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });
    mockSaveDiagramGraph.mockRejectedValue("boom");

    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() =>
      expect(useDiagramStore.getState().diagramId).toBe("d1"),
    );

    useDiagramStore.getState().addNode({
      data: { label: "Workers", typeId: "worker" },
      id: "n1",
      position: { x: 0, y: 0 },
      type: "cf-node",
    });

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() =>
      expect(useDiagramStore.getState().saveError).toBe("Failed to save."),
    );
  });

  it("persists a debounced title change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() =>
      expect(useDiagramStore.getState().diagramId).toBe("d1"),
    );

    fireEvent.change(screen.getByLabelText("Diagram title"), {
      target: { value: "Renamed" },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockUpdateDiagram).toHaveBeenCalledWith("d1", { title: "Renamed" });
  });

  it("silently tolerates a failed title autosave", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });
    mockUpdateDiagram.mockRejectedValue(new Error("Network error"));

    render(<DiagramCanvas diagramId="d1" />);
    await vi.waitFor(() =>
      expect(useDiagramStore.getState().diagramId).toBe("d1"),
    );

    fireEvent.change(screen.getByLabelText("Diagram title"), {
      target: { value: "Renamed" },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => expect(mockUpdateDiagram).toHaveBeenCalled());
  });

  it("adds a node when a palette item is clicked", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Workers$/ }));

    expect(useDiagramStore.getState().nodes).toHaveLength(1);
    expect(useDiagramStore.getState().nodes[0]?.data.typeId).toBe("worker");
  });

  it("ignores a palette add-node call for a typeId the catalog does not recognize", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });
    vi.mocked(ServicePalette).mockImplementationOnce(({ onAddNode }) => (
      <button type="button" onClick={() => onAddNode("not-a-real-type")}>
        Bogus
      </button>
    ));

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Bogus" }));

    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("allows a drag-over on the canvas so a drop can land", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    const dataTransfer = { dropEffect: "" };
    fireEvent.dragOver(screen.getByTestId("react-flow"), { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("move");
  });

  it("adds a node dropped from the palette via drag-and-drop", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    fireEvent.drop(screen.getByTestId("react-flow"), {
      clientX: 10,
      clientY: 20,
      dataTransfer: { getData: () => "d1" },
    });

    expect(useDiagramStore.getState().nodes).toHaveLength(1);
    expect(useDiagramStore.getState().nodes[0]?.data.typeId).toBe("d1");
  });

  it("ignores a drop that carries no recognizable node type", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    fireEvent.drop(screen.getByTestId("react-flow"), {
      clientX: 10,
      clientY: 20,
      dataTransfer: { getData: () => "not-a-real-type" },
    });

    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("ignores a drop that carries no node type data at all", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    // A drag originating outside the palette (a browser tab, a file from the OS) carries no
    // "application/cf-node-type" data at all, unlike a drop with a recognizable-but-unknown
    // type string.
    fireEvent.drop(screen.getByTestId("react-flow"), {
      clientX: 10,
      clientY: 20,
      dataTransfer: { getData: () => "" },
    });

    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("selects and deselects nodes/edges via canvas interactions", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("rf-node-click"));
    expect(useDiagramStore.getState().selectedNodeId).toBe("test-node");

    fireEvent.click(screen.getByTestId("rf-edge-click"));
    expect(useDiagramStore.getState().selectedEdgeId).toBe("test-edge");
    expect(useDiagramStore.getState().selectedNodeId).toBeNull();

    fireEvent.click(screen.getByTestId("rf-pane-click"));
    expect(useDiagramStore.getState().selectedEdgeId).toBeNull();
  });

  it("relays the current node selection to other connected identities when it changes", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    mockSendSelectionChange.mockClear();

    act(() => useDiagramStore.getState().setSelectedNode("n1"));

    expect(mockSendSelectionChange).toHaveBeenCalledWith("n1", null);
  });

  it("relays the current edge selection to other connected identities when it changes", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    mockSendSelectionChange.mockClear();

    act(() => useDiagramStore.getState().setSelectedEdge("e1"));

    expect(mockSendSelectionChange).toHaveBeenCalledWith(null, "e1");
  });

  it("relays the pointer position, converted to flow coordinates, as a cursor_moved send on pointer move", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    fireEvent.pointerMove(screen.getByTestId("react-flow"), {
      clientX: 123,
      clientY: 456,
    });

    // `mockScreenToFlowPosition` (`../../test/mock-xyflow.tsx`) is the identity function by
    // default, so the flow-space coordinates sent equal the raw screen coordinates here.
    expect(mockSendCursor).toHaveBeenCalledWith(123, 456);
  });

  it("does not relay the pointer position in read-only mode", async () => {
    render(
      <DiagramCanvas
        diagramId="shared-d1"
        readOnly
        initialDiagram={{
          description: "",
          graphData: EMPTY_GRAPH,
          title: "Shared Diagram",
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    fireEvent.pointerMove(screen.getByTestId("react-flow"), {
      clientX: 1,
      clientY: 2,
    });

    expect(mockSendCursor).not.toHaveBeenCalled();
  });

  it("deletes the selection on Delete/Backspace, ignoring keystrokes while editing a field", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    const { container } = render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "W", typeId: "worker" },
          id: "n1",
          position: { x: 0, y: 0 },
          selected: true,
        },
      ],
    });

    // A Delete keystroke while focused on the title input must not delete the selection.
    fireEvent.keyDown(screen.getByLabelText("Diagram title"), {
      key: "Delete",
    });
    expect(useDiagramStore.getState().nodes).toHaveLength(1);

    const root = container.querySelector(".diagram-editor") as HTMLElement;
    fireEvent.keyDown(root, { key: "Delete" });
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("undoes and redoes via Ctrl+Z / Ctrl+Shift+Z on the canvas root", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    const { container } = render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    useDiagramStore.getState().addNode({
      data: { label: "W", typeId: "worker" },
      id: "n1",
      position: { x: 0, y: 0 },
      type: "cf-node",
    });
    expect(useDiagramStore.getState().nodes).toHaveLength(1);

    const root = container.querySelector(".diagram-editor") as HTMLElement;
    fireEvent.keyDown(root, { ctrlKey: true, key: "z" });
    expect(useDiagramStore.getState().nodes).toHaveLength(0);

    fireEvent.keyDown(root, { ctrlKey: true, key: "Z", shiftKey: true });
    expect(useDiagramStore.getState().nodes).toHaveLength(1);
  });

  it("warns before unload when there are unsaved changes", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    useDiagramStore.setState({ dirty: true });

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not warn before unload when there are no unsaved changes", async () => {
    mockGetDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "d1",
      title: "My Diagram",
    });

    render(<DiagramCanvas diagramId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );

    useDiagramStore.setState({ dirty: false });

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  describe("live-socket-connected autosave flush", () => {
    beforeEach(() => {
      mockUseDiagramLiveSync.mockImplementation(() => ({
        connected: true,
        cursors: {},
        participants: {},
        remoteSelections: {},
        sendCursor: mockSendCursor,
        sendOperation: mockSendOperation,
        sendSelectionChange: mockSendSelectionChange,
      }));
      mockSendOperation.mockReturnValue(true);
    });

    it("flushes queued operations over the socket instead of PUTing the whole graph", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mockGetDiagram.mockResolvedValue({
        description: "",
        graphData: EMPTY_GRAPH,
        id: "d1",
        title: "My Diagram",
      });

      render(<DiagramCanvas diagramId="d1" />);
      await vi.waitFor(() =>
        expect(useDiagramStore.getState().diagramId).toBe("d1"),
      );

      useDiagramStore.getState().addNode({
        data: { label: "Workers", typeId: "worker" },
        id: "n1",
        position: { x: 0, y: 0 },
        type: "cf-node",
      });
      expect(useDiagramStore.getState().dirty).toBe(true);

      await vi.advanceTimersByTimeAsync(500);

      expect(mockSendOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "add_node" }),
        expect.any(String),
      );
      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(useDiagramStore.getState().dirty).toBe(false),
      );
      expect(useDiagramStore.getState().pendingOperations.size).toBe(0);
    });

    it("still marks the graph saved when the debounce timer fires with an empty operation queue", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mockGetDiagram.mockResolvedValue({
        description: "",
        graphData: EMPTY_GRAPH,
        id: "d1",
        title: "My Diagram",
      });

      render(<DiagramCanvas diagramId="d1" />);
      await vi.waitFor(() =>
        expect(useDiagramStore.getState().diagramId).toBe("d1"),
      );

      // A title-only change also marks `dirty` (shared flag), but enqueues no operation.
      useDiagramStore.getState().setTitle("Renamed");
      expect(useDiagramStore.getState().dirty).toBe(true);

      await vi.advanceTimersByTimeAsync(500);

      expect(mockSendOperation).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(useDiagramStore.getState().dirty).toBe(false),
      );
    });
  });

  describe("read-only mode (the public share viewer)", () => {
    const SHARED_GRAPH = JSON.stringify({
      edges: [],
      nodes: [
        {
          data: { label: "Workers", typeId: "worker" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    it("renders from initialDiagram without ever calling the owner-authenticated getDiagram", async () => {
      render(
        <DiagramCanvas
          diagramId="shared-d1"
          readOnly
          initialDiagram={{
            description: "A shared diagram",
            graphData: SHARED_GRAPH,
            title: "Shared Diagram",
          }}
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
      );
      expect(mockGetDiagram).not.toHaveBeenCalled();
      expect(useDiagramStore.getState().nodes).toHaveLength(1);
      expect(screen.getByText("Shared Diagram")).toBeInTheDocument();
    });

    it("defaults a null shared description to an empty string", async () => {
      render(
        <DiagramCanvas
          diagramId="shared-d1"
          readOnly
          initialDiagram={{
            description: null,
            graphData: EMPTY_GRAPH,
            title: "Shared Diagram",
          }}
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
      );
      expect(useDiagramStore.getState().description).toBe("");
    });

    it("hides the palette and properties panel, and shows a read-only status", async () => {
      render(
        <DiagramCanvas
          diagramId="shared-d1"
          readOnly
          initialDiagram={{
            description: "",
            graphData: EMPTY_GRAPH,
            title: "Shared Diagram",
          }}
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
      );
      expect(screen.queryByPlaceholderText(/search/iu)).not.toBeInTheDocument();
      expect(screen.getByText("Read-only")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Undo (Ctrl+Z)" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Share diagram" }),
      ).not.toBeInTheDocument();
    });

    it("never autosaves, even if the store is dirtied directly", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      render(
        <DiagramCanvas
          diagramId="shared-d1"
          readOnly
          initialDiagram={{
            description: "",
            graphData: EMPTY_GRAPH,
            title: "Shared Diagram",
          }}
        />,
      );
      await vi.waitFor(() =>
        expect(useDiagramStore.getState().diagramId).toBe("shared-d1"),
      );

      useDiagramStore.setState({ dirty: true });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(mockSaveDiagramGraph).not.toHaveBeenCalled();
      expect(mockUpdateDiagram).not.toHaveBeenCalled();
    });

    it("does not warn before unload even when the store is dirtied directly", async () => {
      render(
        <DiagramCanvas
          diagramId="shared-d1"
          readOnly
          initialDiagram={{
            description: "",
            graphData: EMPTY_GRAPH,
            title: "Shared Diagram",
          }}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
      );

      useDiagramStore.setState({ dirty: true });

      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it("ignores Delete/undo/redo keyboard shortcuts", async () => {
      const { container } = render(
        <DiagramCanvas
          diagramId="shared-d1"
          readOnly
          initialDiagram={{
            description: "",
            graphData: SHARED_GRAPH,
            title: "Shared Diagram",
          }}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
      );

      const root = container.querySelector(".diagram-editor") as HTMLElement;
      useDiagramStore.setState({
        nodes: useDiagramStore
          .getState()
          .nodes.map((node) => ({ ...node, selected: true })),
      });
      fireEvent.keyDown(root, { key: "Delete" });
      expect(useDiagramStore.getState().nodes).toHaveLength(1);
    });

    it("never relays selection changes", async () => {
      mockSendSelectionChange.mockClear();
      render(
        <DiagramCanvas
          diagramId="shared-d1"
          readOnly
          initialDiagram={{
            description: "",
            graphData: SHARED_GRAPH,
            title: "Shared Diagram",
          }}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByTestId("rf-node-click"));

      expect(mockSendSelectionChange).not.toHaveBeenCalled();
    });

    it("ignores a drop attempt on the read-only canvas", async () => {
      render(
        <DiagramCanvas
          diagramId="shared-d1"
          readOnly
          initialDiagram={{
            description: "",
            graphData: EMPTY_GRAPH,
            title: "Shared Diagram",
          }}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
      );

      fireEvent.drop(screen.getByTestId("react-flow"), {
        clientX: 10,
        clientY: 20,
        dataTransfer: { getData: () => "worker" },
      });

      expect(useDiagramStore.getState().nodes).toHaveLength(0);
    });
  });

  describe("print mode", () => {
    beforeEach(() => {
      mockXyflow.mockGetNodes.mockReset().mockReturnValue([]);
      mockXyflow.mockGetNodesBounds
        .mockReset()
        .mockReturnValue({ height: 300, width: 400, x: 0, y: 0 });
      mockXyflow.mockFitView.mockClear();
      document.body.classList.remove("diagram-editor-print-mode");
      document.getElementById("diagram-editor-print-orientation")?.remove();
      document.documentElement.style.colorScheme = "";
      // Every sub-test below may trigger the print effect's real (unmocked)
      // requestAnimationFrame -> setTimeout -> window.print() chain, whether or not that chain
      // is what the test is actually asserting on; stub it globally here so jsdom's "not
      // implemented" console noise from a real, un-awaited call never leaks into an unrelated
      // test.
      vi.spyOn(window, "print").mockImplementation(() => {});
    });

    async function renderLoaded() {
      mockGetDiagram.mockResolvedValue({
        description: "A test diagram",
        graphData: EMPTY_GRAPH,
        id: "d1",
        title: "My Diagram",
      });
      const view = render(<DiagramCanvas diagramId="d1" />);
      await waitFor(() =>
        expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
      );
      return view;
    }

    it("hides the toolbar, palette, properties panel, and status bar while printing", async () => {
      await renderLoaded();

      act(() => useDiagramStore.getState().setPrintMode(true));

      expect(screen.queryByLabelText("Diagram title")).not.toBeInTheDocument();
      expect(screen.queryByTitle("Share diagram")).not.toBeInTheDocument();
      expect(screen.getByText("My Diagram")).toBeInTheDocument();
      expect(screen.getByText("A test diagram")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Exit print mode" }),
      ).toBeInTheDocument();
    });

    it("forces a light color scheme and restores the previous one on exit", async () => {
      document.documentElement.style.colorScheme = "dark";
      await renderLoaded();

      act(() => useDiagramStore.getState().setPrintMode(true));
      expect(document.documentElement.style.colorScheme).toBe("light");

      act(() => useDiagramStore.getState().setPrintMode(false));
      expect(document.documentElement.style.colorScheme).toBe("dark");
    });

    it("chooses a landscape page orientation for a wider-than-tall diagram", async () => {
      mockXyflow.mockGetNodes.mockReturnValue([
        { data: { label: "A", typeId: "worker" }, id: "a" },
      ]);
      mockXyflow.mockGetNodesBounds.mockReturnValue({
        height: 100,
        width: 500,
        x: 0,
        y: 0,
      });
      await renderLoaded();

      act(() => useDiagramStore.getState().setPrintMode(true));

      const style = document.getElementById("diagram-editor-print-orientation");
      expect(style?.textContent).toContain("landscape");
    });

    it("chooses a portrait page orientation for a taller-than-wide diagram", async () => {
      mockXyflow.mockGetNodes.mockReturnValue([
        { data: { label: "A", typeId: "worker" }, id: "a" },
      ]);
      mockXyflow.mockGetNodesBounds.mockReturnValue({
        height: 500,
        width: 100,
        x: 0,
        y: 0,
      });
      await renderLoaded();

      act(() => useDiagramStore.getState().setPrintMode(true));

      const style = document.getElementById("diagram-editor-print-orientation");
      expect(style?.textContent).toContain("portrait");
    });

    it("fits the view and opens the print dialog shortly after entering print mode", async () => {
      const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
      await renderLoaded();

      act(() => useDiagramStore.getState().setPrintMode(true));

      await waitFor(() => expect(mockXyflow.mockFitView).toHaveBeenCalled());
      await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    });

    it("exits print mode and restores state when the browser reports afterprint", async () => {
      await renderLoaded();

      act(() => useDiagramStore.getState().setPrintMode(true));
      expect(
        document.body.classList.contains("diagram-editor-print-mode"),
      ).toBe(true);

      act(() => window.dispatchEvent(new Event("afterprint")));

      expect(useDiagramStore.getState().printMode).toBe(false);
      expect(
        document.body.classList.contains("diagram-editor-print-mode"),
      ).toBe(false);
      expect(
        document.getElementById("diagram-editor-print-orientation"),
      ).toBeNull();
    });

    it("exits print mode via the exit button", async () => {
      await renderLoaded();
      act(() => useDiagramStore.getState().setPrintMode(true));

      fireEvent.click(screen.getByRole("button", { name: "Exit print mode" }));

      expect(useDiagramStore.getState().printMode).toBe(false);
      expect(
        document.body.classList.contains("diagram-editor-print-mode"),
      ).toBe(false);
    });

    it("omits the description box when the diagram has none", async () => {
      mockGetDiagram.mockResolvedValue({
        description: "",
        graphData: EMPTY_GRAPH,
        id: "d1",
        title: "My Diagram",
      });
      render(<DiagramCanvas diagramId="d1" />);
      await waitFor(() =>
        expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
      );

      act(() => useDiagramStore.getState().setPrintMode(true));

      expect(
        document.querySelector(".diagram-editor__print-description"),
      ).toBeNull();
    });
  });
});
