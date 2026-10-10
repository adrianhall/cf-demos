import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiagramStore } from "../../../stores/diagramStore";
import { ConnectNodesModal } from "./ConnectNodesModal";

describe("ConnectNodesModal", () => {
  beforeEach(() => {
    useDiagramStore.setState({
      diagramId: "d1",
      dirty: false,
      edges: [],
      nodes: [
        {
          data: { label: "API Worker", typeId: "worker" },
          id: "a",
          position: { x: 0, y: 0 },
          type: "cf-node",
        },
        {
          data: { label: "Primary DB", typeId: "d1" },
          id: "b",
          position: { x: 300, y: 0 },
          type: "cf-node",
        },
        {
          data: { label: "Cache", typeId: "kv" },
          id: "c",
          position: { x: 0, y: 300 },
          type: "cf-node",
        },
      ],
      redoStack: [],
      selectedEdgeId: null,
      selectedNodeId: null,
      undoStack: [],
    });
  });

  it("does not render when closed", () => {
    render(<ConnectNodesModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("falls back to the raw typeId when a node's catalog type is unrecognized", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "Legacy Node", typeId: "not-a-real-type" },
          id: "a",
          position: { x: 0, y: 0 },
          type: "cf-node",
        },
        {
          data: { label: "Primary DB", typeId: "d1" },
          id: "b",
          position: { x: 300, y: 0 },
          type: "cf-node",
        },
      ],
    });
    render(<ConnectNodesModal open onClose={vi.fn()} />);
    expect(
      screen.getAllByRole("option", { name: "Legacy Node (not-a-real-type)" }),
    ).not.toHaveLength(0);
  });

  it("lists every node, type-qualified, in the source and target dropdowns", () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);
    const source = screen.getByLabelText(
      "Source",
    ) as unknown as HTMLSelectElement;
    expect(Array.from(source.options).map((option) => option.text)).toEqual([
      "API Worker (Workers)",
      "Primary DB (D1 Database)",
      "Cache (Workers KV)",
    ]);
  });

  it("changes the source via its dropdown", () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "b" },
    });
    expect(screen.getByLabelText("Source")).toHaveValue("b");
  });

  it("defaults the source to the currently selected node", () => {
    useDiagramStore.setState({ selectedNodeId: "b" });
    render(<ConnectNodesModal open onClose={vi.fn()} />);
    expect(screen.getByLabelText("Source")).toHaveValue("b");
    expect(screen.getByLabelText("Target")).toHaveValue("a");
  });

  it("shows a validation message and disables Connect for a self-connection", () => {
    render(<ConnectNodesModal open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Target"), {
      target: { value: "a" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A node cannot be connected to itself.",
    );
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("shows a validation message for an exact source/target/edge-type duplicate", () => {
    useDiagramStore.setState({
      edges: [
        {
          data: { edgeType: "data-flow" },
          id: "e1",
          source: "a",
          target: "b",
        },
      ],
    });
    render(<ConnectNodesModal open onClose={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "These nodes are already connected with that edge type.",
    );
  });

  it("closes without mutating the store on Escape", () => {
    const onClose = vi.fn();
    render(<ConnectNodesModal open onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(useDiagramStore.getState().edges).toHaveLength(0);
  });

  it("closes without mutating the store via Cancel", () => {
    const onClose = vi.fn();
    render(<ConnectNodesModal open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(useDiagramStore.getState().edges).toHaveLength(0);
  });

  it("creates the edge and closes on Connect", () => {
    const onClose = vi.fn();
    render(<ConnectNodesModal open onClose={onClose} />);

    // Source defaults to the first node ("a"); pick "Cache" as the target and "Trigger" as the
    // connection type via their native <select>s and activate the native <button> below -- every
    // control here is a real, natively keyboard-operable HTML form element (pressing Enter/Space
    // on a focused native <button> activates it without any extra wiring), unlike
    // `@xyflow/react`'s drag-only `Handle` divs this dialog exists to route around (see this
    // component's own JSDoc).
    fireEvent.change(screen.getByLabelText("Target"), {
      target: { value: "c" },
    });
    fireEvent.change(screen.getByLabelText("Connection type"), {
      target: { value: "trigger" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const state = useDiagramStore.getState();
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0]).toMatchObject({
      data: { edgeType: "trigger" },
      source: "a",
      target: "c",
    });
    expect(onClose).toHaveBeenCalled();
  });
});
