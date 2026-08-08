import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const { useDiagramStore } = await import("../../stores/diagramStore");
const { DiagramCanvas } = await import("./DiagramCanvas");

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
      dirty: false,
      saving: false,
      saveError: null,
      lastSavedAt: null,
      undoStack: [],
      redoStack: [],
    });
    mockGetDiagram.mockReset();
    mockSaveDiagramGraph
      .mockReset()
      .mockResolvedValue("2026-01-01T00:00:00.000Z");
    mockUpdateDiagram.mockReset().mockResolvedValue({});
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
});
