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

const { mockListCollaborators } = vi.hoisted(() => ({
  mockListCollaborators: vi.fn(),
}));
vi.mock("../../../api/collaborators", () => ({
  addCollaborator: vi.fn(),
  listCollaborators: mockListCollaborators,
  removeCollaborator: vi.fn(),
}));

const { mockUseIdentity } = vi.hoisted(() => ({ mockUseIdentity: vi.fn() }));
vi.mock("../../../hooks/useIdentity", () => ({
  useIdentity: mockUseIdentity,
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

  it("leaves an edge unchanged when its source node has an unrecognized catalog type", () => {
    // Every current catalog product has at least one of "source-bottom"/"source-right" among
    // its default handles (see `../../../../catalog.ts`), so a *known* type never actually
    // fails this match on the source side -- only an unrecognized/legacy `typeId` (an old
    // diagram referencing a since-removed catalog product) can, mirroring how this same
    // function already tolerates an unrecognized *target* type.
    const mixedNodes = [
      {
        data: { label: "Legacy", typeId: "not-a-real-type" },
        id: "legacy",
        position: { x: 0, y: 0 },
      },
      {
        data: { label: "D", typeId: "worker" },
        id: "d",
        position: { x: 0, y: 0 },
      },
    ];
    const edges = [
      { id: "e1", source: "legacy", sourceHandle: "custom", target: "d" },
    ];
    const [remapped] = remapEdgeHandles(edges, mixedNodes, "DOWN");
    expect(remapped.sourceHandle).toBe("custom");
  });

  it("leaves an edge unchanged when its target node has an unrecognized catalog type", () => {
    const mixedNodes = [
      {
        data: { label: "D", typeId: "worker" },
        id: "d",
        position: { x: 0, y: 0 },
      },
      {
        data: { label: "Legacy", typeId: "not-a-real-type" },
        id: "legacy",
        position: { x: 0, y: 0 },
      },
    ];
    const edges = [
      { id: "e1", source: "d", target: "legacy", targetHandle: "custom" },
    ];
    const [remapped] = remapEdgeHandles(edges, mixedNodes, "DOWN");
    expect(remapped.targetHandle).toBe("custom");
  });

  it("leaves an edge unchanged when it references a node id not present in the diagram", () => {
    // An edge can reference a node id no longer in `nodes` (for example, mid-delete); both
    // lookups fail closed and the edge keeps its existing handles.
    const edges = [
      {
        id: "e1",
        source: "missing-source",
        sourceHandle: "custom-source",
        target: "missing-target",
        targetHandle: "custom-target",
      },
    ];
    const [remapped] = remapEdgeHandles(edges, nodes, "DOWN");
    expect(remapped).toMatchObject({
      sourceHandle: "custom-source",
      targetHandle: "custom-target",
    });
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
      ownerEmail: null,
      paletteOpen: true,
      propertiesOpen: false,
      minimapOpen: true,
      detailsPanelTab: "properties",
      detailsPanelExpanded: false,
    });
    mockXyflow.mockFitView.mockClear();
    mockXyflow.mockZoomIn.mockClear();
    mockXyflow.mockZoomOut.mockClear();
    mockElkLayout.mockReset();
    mockGetShareStatus.mockReset();
    mockListCollaborators.mockReset();
    mockUseIdentity.mockReset().mockReturnValue({
      email: "owner@example.com",
      error: null,
      isAdmin: false,
      loading: false,
    });
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

  it("renders the presence stack when participants are given, not in read-only mode", () => {
    const { rerender } = render(
      <Toolbar
        participants={{
          "bob@example.com": {
            color: "#111111",
            displayName: null,
            email: "bob@example.com",
          },
        }}
      />,
    );
    expect(
      screen.getByRole("list", { name: "Currently viewing" }),
    ).toBeInTheDocument();

    rerender(
      <Toolbar
        readOnly
        participants={{
          "bob@example.com": {
            color: "#111111",
            displayName: null,
            email: "bob@example.com",
          },
        }}
      />,
    );
    expect(
      screen.queryByRole("list", { name: "Currently viewing" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the presence stack when no participants prop is given", () => {
    render(<Toolbar />);
    expect(
      screen.queryByRole("list", { name: "Currently viewing" }),
    ).not.toBeInTheDocument();
  });

  it("toggles the service palette and properties panel through the store (Bug 4)", () => {
    render(<Toolbar />);

    const paletteToggle = screen.getByTitle("Toggle service palette");
    expect(paletteToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(paletteToggle);
    expect(useDiagramStore.getState().paletteOpen).toBe(false);

    const propertiesToggle = screen.getByTitle("Toggle properties panel");
    expect(propertiesToggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(propertiesToggle);
    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
  });

  it("opens the AI Assistant tab and the details panel, nudging the palette closed once (docs/09D-ARCHITECT-AICHAT.md)", () => {
    useDiagramStore.setState({
      paletteOpen: true,
      propertiesOpen: false,
      detailsPanelTab: "properties",
    });
    render(<Toolbar />);

    const aiButton = screen.getByTitle("AI Assistant");
    expect(aiButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(aiButton);
    expect(useDiagramStore.getState().detailsPanelTab).toBe("ai-chat");
    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
    expect(useDiagramStore.getState().paletteOpen).toBe(false);

    // Re-open the palette manually -- the one-time nudge must never re-close it again.
    useDiagramStore.getState().togglePalette();
    expect(useDiagramStore.getState().paletteOpen).toBe(true);
    fireEvent.click(aiButton);
    expect(useDiagramStore.getState().paletteOpen).toBe(true);
  });

  it("does not close an already-closed palette on the first AI Assistant click", () => {
    useDiagramStore.setState({ paletteOpen: false, propertiesOpen: false });
    render(<Toolbar />);

    fireEvent.click(screen.getByTitle("AI Assistant"));
    expect(useDiagramStore.getState().paletteOpen).toBe(false);
  });

  it("aria-pressed on the AI Assistant button reflects both the panel being open and its tab", () => {
    useDiagramStore.setState({
      propertiesOpen: true,
      detailsPanelTab: "ai-chat",
    });
    render(<Toolbar />);
    expect(screen.getByTitle("AI Assistant")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("does not read AI Assistant as pressed when the details panel itself is closed", () => {
    useDiagramStore.setState({
      propertiesOpen: false,
      detailsPanelTab: "ai-chat",
    });
    render(<Toolbar />);
    expect(screen.getByTitle("AI Assistant")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("does not leave the AI Assistant tab open when it is already open (no-op re-toggle of the panel)", () => {
    useDiagramStore.setState({
      propertiesOpen: true,
      detailsPanelTab: "properties",
    });
    render(<Toolbar />);

    fireEvent.click(screen.getByTitle("AI Assistant"));
    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
    expect(useDiagramStore.getState().detailsPanelTab).toBe("ai-chat");
  });

  it("renders no AI Assistant button in read-only mode", () => {
    render(<Toolbar readOnly />);
    expect(screen.queryByTitle("AI Assistant")).not.toBeInTheDocument();
  });

  it("toggles the minimap through the store", () => {
    render(<Toolbar />);

    const minimapToggle = screen.getByTitle("Toggle minimap");
    expect(minimapToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(minimapToggle);
    expect(useDiagramStore.getState().minimapOpen).toBe(false);
  });

  it("renders no minimap toggle in read-only mode", () => {
    render(<Toolbar readOnly />);
    expect(screen.queryByTitle("Toggle minimap")).not.toBeInTheDocument();
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

  it("leaves the layout direction menu open when clicking inside it", () => {
    render(<Toolbar />);

    const menuButton = screen.getByLabelText("Choose layout direction");
    fireEvent.click(menuButton);
    expect(screen.getByText("→ Left to right")).toBeInTheDocument();

    fireEvent.mouseDown(menuButton);
    expect(screen.getByText("→ Left to right")).toBeInTheDocument();
  });

  it("threads the current edges into the ELK graph", async () => {
    useDiagramStore.setState({
      nodes: [
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
      ],
      edges: [{ id: "e1", source: "a", target: "b" }],
    });
    mockElkLayout.mockResolvedValue({ children: [] });

    render(<Toolbar />);
    fireEvent.click(screen.getByTitle(/Auto layout/));

    await waitFor(() => expect(mockElkLayout).toHaveBeenCalled());
    const graph = mockElkLayout.mock.calls[0]?.[0];
    expect(graph.edges).toEqual([{ id: "e1", sources: ["a"], targets: ["b"] }]);
  });

  it("leaves the store untouched when ELK returns no children", async () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "A", typeId: "worker" },
          id: "a",
          position: { x: 1, y: 2 },
        },
      ],
      edges: [],
    });
    mockElkLayout.mockResolvedValue({});

    render(<Toolbar />);
    fireEvent.click(screen.getByTitle(/Auto layout/));

    await waitFor(() => expect(mockElkLayout).toHaveBeenCalled());
    // No `children` in ELK's response means the store's nodes are never replaced.
    expect(useDiagramStore.getState().nodes[0]?.position).toEqual({
      x: 1,
      y: 2,
    });
  });

  it("defaults a computed position's missing x/y to 0", async () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "A", typeId: "worker" },
          id: "a",
          position: { x: 9, y: 9 },
        },
      ],
      edges: [],
    });
    mockElkLayout.mockResolvedValue({ children: [{ id: "a" }] });

    render(<Toolbar />);
    fireEvent.click(screen.getByTitle(/Auto layout/));

    await waitFor(() =>
      expect(useDiagramStore.getState().nodes[0]?.position).toEqual({
        x: 0,
        y: 0,
      }),
    );
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

  it("renders export, print, and dark mode controls even in read-only mode", () => {
    render(<Toolbar readOnly />);
    expect(screen.getByTitle("Export")).toBeInTheDocument();
    expect(screen.getByTitle("Print")).toBeInTheDocument();
    expect(screen.getByTitle("Toggle dark mode")).toBeInTheDocument();
  });

  it("renders export, print, share, and dark mode controls together when not read-only", () => {
    render(<Toolbar />);
    expect(screen.getByTitle("Export")).toBeInTheDocument();
    expect(screen.getByTitle("Print")).toBeInTheDocument();
    expect(screen.getByTitle("Share diagram")).toBeInTheDocument();
    expect(screen.getByTitle("Toggle dark mode")).toBeInTheDocument();
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

  it("disables the Manage collaborators button until a diagram has loaded", () => {
    render(<Toolbar />);
    expect(screen.getByTitle("Manage collaborators")).toBeDisabled();
  });

  it("renders no Manage collaborators button at all in read-only mode", () => {
    render(<Toolbar readOnly />);
    expect(screen.queryByTitle("Manage collaborators")).not.toBeInTheDocument();
  });

  it("opens the collaborators modal for the loaded diagram", async () => {
    useDiagramStore.setState({
      diagramId: "d1",
      ownerEmail: "owner@example.com",
    });
    mockListCollaborators.mockResolvedValue([]);

    render(<Toolbar />);
    expect(screen.getByTitle("Manage collaborators")).not.toBeDisabled();

    fireEvent.click(screen.getByTitle("Manage collaborators"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockListCollaborators).toHaveBeenCalledWith("d1"),
    );
  });

  it("closes the collaborators modal", async () => {
    useDiagramStore.setState({
      diagramId: "d1",
      ownerEmail: "owner@example.com",
    });
    mockListCollaborators.mockResolvedValue([]);

    render(<Toolbar />);
    fireEvent.click(screen.getByTitle("Manage collaborators"));
    await waitFor(() => screen.getByRole("dialog"));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables the Connect nodes button with fewer than two nodes (Bug 8)", () => {
    render(<Toolbar />);
    expect(screen.getByTitle("Connect nodes")).toBeDisabled();
  });

  it("enables the Connect nodes button with at least two nodes and opens its dialog (Bug 8)", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "A", typeId: "worker" },
          id: "a",
          position: { x: 0, y: 0 },
        },
        {
          data: { label: "B", typeId: "worker" },
          id: "b",
          position: { x: 300, y: 0 },
        },
      ],
    });
    render(<Toolbar />);

    expect(screen.getByTitle("Connect nodes")).not.toBeDisabled();
    fireEvent.click(screen.getByTitle("Connect nodes"));
    expect(
      screen.getByRole("dialog", { name: "Connect Nodes" }),
    ).toBeInTheDocument();
  });

  it("renders no Connect nodes button at all in read-only mode (Bug 8)", () => {
    render(<Toolbar readOnly />);
    expect(screen.queryByTitle("Connect nodes")).not.toBeInTheDocument();
  });

  it("closes the connect nodes dialog via its Cancel control (Bug 8)", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "A", typeId: "worker" },
          id: "a",
          position: { x: 0, y: 0 },
        },
        {
          data: { label: "B", typeId: "worker" },
          id: "b",
          position: { x: 300, y: 0 },
        },
      ],
    });
    render(<Toolbar />);

    fireEvent.click(screen.getByTitle("Connect nodes"));
    expect(
      screen.getByRole("dialog", { name: "Connect Nodes" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Connect Nodes" }),
    ).not.toBeInTheDocument();
  });
});
