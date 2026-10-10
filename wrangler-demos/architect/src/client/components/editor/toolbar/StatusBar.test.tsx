import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { useDiagramStore } = await import("../../../stores/diagramStore");
const { StatusBar } = await import("./StatusBar");

describe("StatusBar", () => {
  beforeEach(() => {
    useDiagramStore.setState({
      nodes: [],
      edges: [],
      saving: false,
      dirty: false,
      lastSavedAt: null,
      saveError: null,
    });
    mockXyflow.mockGetZoom.mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows read-only status regardless of store state", () => {
    render(<StatusBar readOnly />);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("shows 'No changes' before any save has happened", () => {
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("shows 'Unsaved changes' when dirty", () => {
    useDiagramStore.setState({ dirty: true });
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("shows 'Saving…' while a save is in flight", () => {
    useDiagramStore.setState({ saving: true });
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("Saving…")).toBeInTheDocument();
  });

  it("shows the save error message", () => {
    useDiagramStore.setState({ saveError: "Network error" });
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("Error: Network error")).toBeInTheDocument();
  });

  it("shows a relative 'Saved ... ago' time once saved", () => {
    useDiagramStore.setState({ lastSavedAt: Date.now() });
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("Saved just now")).toBeInTheDocument();
  });

  it("shows seconds once at least 5 seconds have passed", () => {
    useDiagramStore.setState({ lastSavedAt: Date.now() - 30_000 });
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("Saved 30s ago")).toBeInTheDocument();
  });

  it("shows minutes once at least 60 seconds have passed", () => {
    useDiagramStore.setState({ lastSavedAt: Date.now() - 125_000 });
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("Saved 2m ago")).toBeInTheDocument();
  });

  it("reports node and edge counts with correct pluralization", () => {
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
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("1 node, 0 edges")).toBeInTheDocument();
  });

  it("uses singular 'edge' for exactly one edge", () => {
    useDiagramStore.setState({
      nodes: [],
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
    });
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("0 nodes, 1 edge")).toBeInTheDocument();
  });

  it("polls the zoom level once per second", () => {
    vi.useFakeTimers();
    mockXyflow.mockGetZoom.mockReturnValue(1);
    render(<StatusBar readOnly={false} />);
    expect(screen.getByText("Zoom: 100%")).toBeInTheDocument();

    mockXyflow.mockGetZoom.mockReturnValue(1.5);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Zoom: 150%")).toBeInTheDocument();
  });
});
