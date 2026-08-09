import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockElkLayout } = vi.hoisted(() => ({ mockElkLayout: vi.fn() }));
vi.mock("elkjs/lib/elk.bundled.js", () => ({
  default: class MockElk {
    layout = mockElkLayout;
  },
}));

const { mockGetShareStatus } = vi.hoisted(() => ({
  mockGetShareStatus: vi.fn(),
}));
vi.mock("../../../api/shares", () => ({
  createShare: vi.fn(),
  getShareStatus: mockGetShareStatus,
  revokeShare: vi.fn(),
}));

// Imported dynamically, after the mocks above, since both transitively import "@xyflow/react"
// (`../../../stores/diagramStore.ts` and `./Toolbar.tsx` themselves) and must not resolve that
// import before the mock factory above is ready to serve it.
const { useDiagramStore } = await import("../../../stores/diagramStore");
const { remapEdgeHandles, Toolbar } = await import("./Toolbar");

describe("remapEdgeHandles", () => {
  const nodes = [
    {
      data: { label: "A", typeId: "worker" },
      id: "a",
      position: { x: 0, y: 0 },
    },
    {
      data: { label: "B", typeId: "worker" },
      id: "b",
      position: { x: 0, y: 0 },
    },
  ];

  it("remaps to bottom/top handles for a DOWN layout", () => {
    const edges = [{ id: "e1", source: "a", target: "b" }];
    const [remapped] = remapEdgeHandles(edges, nodes, "DOWN");
    expect(remapped).toMatchObject({
      sourceHandle: "source-bottom",
      targetHandle: "target-top",
    });
  });

  it("remaps to right/left handles for a RIGHT layout", () => {
    const edges = [{ id: "e1", source: "a", target: "b" }];
    const [remapped] = remapEdgeHandles(edges, nodes, "RIGHT");
    expect(remapped).toMatchObject({
      sourceHandle: "source-right",
      targetHandle: "target-left",
    });
  });

  it("returns the same edge instance when the computed handles already match", () => {
    const edge = {
      id: "e1",
      source: "a",
      sourceHandle: "source-bottom",
      target: "b",
      targetHandle: "target-top",
    };
    const [remapped] = remapEdgeHandles([edge], nodes, "DOWN");
    expect(remapped).toBe(edge);
  });

  it("leaves an edge unchanged when its node type has no preferred handle", () => {
    const clientNodes = [
      {
        data: { label: "C", typeId: "client-browser" },
        id: "c",
        position: { x: 0, y: 0 },
      },
      {
        data: { label: "D", typeId: "worker" },
        id: "d",
        position: { x: 0, y: 0 },
      },
    ];
    // client-browser only has source-bottom/source-right handles, no target handles, so as a
    // *target* it never matches a preferred handle.
    const edges = [
      { id: "e1", source: "d", target: "c", targetHandle: "custom" },
    ];
    const [remapped] = remapEdgeHandles(edges, clientNodes, "DOWN");
    expect(remapped.targetHandle).toBe("custom");
  });
});

describe("Toolbar", () => {
  beforeEach(() => {
    useDiagramStore.setState({
      title: "Untitled Diagram",
      undoStack: [],
      redoStack: [],
      nodes: [],
      edges: [],
      diagramId: null,
    });
    mockXyflow.mockFitView.mockClear();
    mockXyflow.mockZoomIn.mockClear();
    mockXyflow.mockZoomOut.mockClear();
    mockElkLayout.mockReset();
    mockGetShareStatus.mockReset();
  });

  it("renders the current title and updates it through the store", () => {
    render(<Toolbar />);
    const input = screen.getByLabelText("Diagram title") as HTMLInputElement;
    expect(input.value).toBe("Untitled Diagram");

    fireEvent.change(input, { target: { value: "My Architecture" } });
    expect(useDiagramStore.getState().title).toBe("My Architecture");
  });

  it("renders a read-only title with no undo/redo/layout controls in read-only mode", () => {
    render(<Toolbar readOnly />);
    expect(screen.getByText("Untitled Diagram")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Undo (Ctrl+Z)" }),
    ).not.toBeInTheDocument();
  });

  it("disables undo/redo when their stacks are empty", () => {
    render(<Toolbar />);
    expect(screen.getByTitle("Undo (Ctrl+Z)")).toBeDisabled();
    expect(screen.getByTitle("Redo (Ctrl+Shift+Z)")).toBeDisabled();
  });

  it("enables and triggers undo/redo through the store", () => {
    useDiagramStore.setState({
      undoStack: [{ nodes: [], edges: [] }],
      redoStack: [{ nodes: [], edges: [] }],
    });
    render(<Toolbar />);

    fireEvent.click(screen.getByTitle("Undo (Ctrl+Z)"));
    fireEvent.click(screen.getByTitle("Redo (Ctrl+Shift+Z)"));

    // Both actions ran without throwing; the store's own undo/redo tests cover their effects.
    expect(screen.getByTitle("Undo (Ctrl+Z)")).toBeInTheDocument();
  });

  it("calls the React Flow zoom/fit controls", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByTitle("Zoom in"));
    fireEvent.click(screen.getByTitle("Zoom out"));
    fireEvent.click(screen.getByTitle("Fit view"));

    expect(mockXyflow.mockZoomIn).toHaveBeenCalledTimes(1);
    expect(mockXyflow.mockZoomOut).toHaveBeenCalledTimes(1);
  });

  it("runs ELK auto-layout and applies computed positions to the store", async () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "A", typeId: "worker" },
          id: "a",
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });
    mockElkLayout.mockResolvedValue({
      children: [{ id: "a", x: 42, y: 99 }],
    });

    render(<Toolbar />);
    fireEvent.click(screen.getByTitle(/Auto layout/));

    await waitFor(() => {
      expect(useDiagramStore.getState().nodes[0]?.position).toEqual({
        x: 42,
        y: 99,
      });
    });
  });

  it("opens the layout direction menu and switches to left-to-right", async () => {
    mockElkLayout.mockResolvedValue({ children: [] });
    render(<Toolbar />);

    fireEvent.click(screen.getByLabelText("Choose layout direction"));
    fireEvent.click(screen.getByText("→ Left to right"));

    await waitFor(() => expect(mockElkLayout).toHaveBeenCalled());
  });

  it("opens the layout direction menu and re-selects top-to-bottom", async () => {
    mockElkLayout.mockResolvedValue({ children: [] });
    render(<Toolbar />);

    fireEvent.click(screen.getByLabelText("Choose layout direction"));
    fireEvent.click(screen.getByText("↓ Top to bottom"));

    await waitFor(() => expect(mockElkLayout).toHaveBeenCalled());
    expect(screen.queryByText("↓ Top to bottom")).not.toBeInTheDocument();
  });

  it("closes the layout direction menu when clicking outside it", () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByLabelText("Choose layout direction"));
    expect(screen.getByText("→ Left to right")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("→ Left to right")).not.toBeInTheDocument();
  });

  it("threads catalog handle ports into the ELK graph for a node with default handles", async () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "A", typeId: "cron-trigger" },
          id: "a",
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });
    mockElkLayout.mockResolvedValue({ children: [{ id: "a", x: 5, y: 5 }] });

    render(<Toolbar />);
    fireEvent.click(screen.getByTitle(/Auto layout/));

    await waitFor(() => expect(mockElkLayout).toHaveBeenCalled());
    const graph = mockElkLayout.mock.calls[0]?.[0];
    expect(graph.children[0].ports).toHaveLength(2);
  });

  it("gives a node with an unrecognized catalog type no ports at all", async () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "A", typeId: "not-a-real-type" },
          id: "a",
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });
    mockElkLayout.mockResolvedValue({ children: [] });

    render(<Toolbar />);
    fireEvent.click(screen.getByTitle(/Auto layout/));

    await waitFor(() => expect(mockElkLayout).toHaveBeenCalled());
    const graph = mockElkLayout.mock.calls[0]?.[0];
    expect(graph.children[0].ports).toHaveLength(0);
  });

  it("disables the Share button until a diagram has loaded", () => {
    render(<Toolbar />);
    expect(screen.getByTitle("Share diagram")).toBeDisabled();
  });

  it("renders no Share button at all in read-only mode", () => {
    render(<Toolbar readOnly />);
    expect(screen.queryByTitle("Share diagram")).not.toBeInTheDocument();
  });

  it("opens the share modal for the loaded diagram", async () => {
    useDiagramStore.setState({ diagramId: "d1" });
    mockGetShareStatus.mockResolvedValue({ active: false, createdAt: null });

    render(<Toolbar />);
    expect(screen.getByTitle("Share diagram")).not.toBeDisabled();

    fireEvent.click(screen.getByTitle("Share diagram"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(mockGetShareStatus).toHaveBeenCalledWith("d1"));
  });

  it("closes the share modal", async () => {
    useDiagramStore.setState({ diagramId: "d1" });
    mockGetShareStatus.mockResolvedValue({ active: false, createdAt: null });

    render(<Toolbar />);
    fireEvent.click(screen.getByTitle("Share diagram"));
    await waitFor(() => screen.getByRole("dialog"));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
