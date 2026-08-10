import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CATEGORY_COLORS, CATEGORY_LABELS } from "../../../../catalog";
import { useDiagramStore } from "../../../stores/diagramStore";
import { PropertiesPanel } from "./PropertiesPanel";

describe("PropertiesPanel", () => {
  beforeEach(() => {
    useDiagramStore.setState({
      nodes: [],
      edges: [],
      selectedNodeId: null,
      selectedEdgeId: null,
    });
  });

  it("shows an empty-state message when nothing is selected", () => {
    render(<PropertiesPanel />);
    expect(
      screen.getByText("Select a node or edge to view its properties."),
    ).toBeInTheDocument();
  });

  it("closes the panel via the close button, regardless of what is selected (Bug 4)", () => {
    useDiagramStore.setState({ propertiesOpen: true });
    render(<PropertiesPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "Close properties panel" }),
    );

    expect(useDiagramStore.getState().propertiesOpen).toBe(false);
  });

  it("shows node properties, including its catalog type and category", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "My Worker", typeId: "worker" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      selectedNodeId: "n1",
    });
    render(<PropertiesPanel />);

    expect(screen.getByText("Workers")).toBeInTheDocument();
    expect(screen.getByText("Compute")).toBeInTheDocument();
    expect(screen.getByLabelText("Label")).toHaveValue("My Worker");
  });

  it("updates a node's description and accent color through the store", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "My Worker", typeId: "worker" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      selectedNodeId: "n1",
    });
    render(<PropertiesPanel />);

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Handles requests" },
    });
    expect(useDiagramStore.getState().nodes[0]?.data.description).toBe(
      "Handles requests",
    );

    fireEvent.change(screen.getByLabelText("Accent Color"), {
      target: { value: "#123456" },
    });
    expect(useDiagramStore.getState().nodes[0]?.data.style?.accentColor).toBe(
      "#123456",
    );
  });

  it("updates a node's label through the store", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "My Worker", typeId: "worker" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      selectedNodeId: "n1",
    });
    render(<PropertiesPanel />);

    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Renamed Worker" },
    });

    expect(useDiagramStore.getState().nodes[0]?.data.label).toBe(
      "Renamed Worker",
    );
  });

  it("defaults the accent color input to the category color, not a bare '#'", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "DB", typeId: "d1" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      selectedNodeId: "n1",
    });
    render(<PropertiesPanel />);

    expect(screen.getByLabelText("Accent Color")).toHaveValue(
      CATEGORY_COLORS.storage.toLowerCase(),
    );
  });

  it("falls back to the external category and the raw typeId for an unrecognized node type", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "Legacy", typeId: "not-a-real-type" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      selectedNodeId: "n1",
    });
    render(<PropertiesPanel />);

    expect(screen.getByText(CATEGORY_LABELS.external)).toBeInTheDocument();
    expect(screen.getByText("not-a-real-type")).toBeInTheDocument();
    expect(screen.getByLabelText("Accent Color")).toHaveValue(
      CATEGORY_COLORS.external.toLowerCase(),
    );
  });

  it("renders documentation links for a node type that has them", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "W", typeId: "worker" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      selectedNodeId: "n1",
    });
    render(<PropertiesPanel />);

    expect(screen.getByRole("link", { name: "Workers Docs" })).toHaveAttribute(
      "href",
      "https://developers.cloudflare.com/workers/",
    );
  });

  it('renders the video icon for a doc link with icon: "video" (Phase 8, docs/09-ARCHITECT.md)', () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "W", typeId: "worker" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      selectedNodeId: "n1",
    });
    render(<PropertiesPanel />);

    const videoLink = screen.getByRole("link", { name: "Workers Video" });
    expect(videoLink).toHaveAttribute(
      "href",
      "https://www.youtube.com/watch?v=H7Qe96fqg1M",
    );
    // The video icon (`react-feather`'s `Video`) is the only doc-link icon built from a
    // `<polygon>` element -- `BookOpen` (the "doc" icon) only ever renders `<path>`s -- so this
    // distinguishes it from a doc-link icon without depending on shared CSS class names.
    expect(videoLink.querySelector("polygon")).not.toBeNull();
  });

  it("shows edge properties and updates the edge type through the store", () => {
    useDiagramStore.setState({
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
      selectedEdgeId: "e1",
    });
    render(<PropertiesPanel />);

    expect(screen.getByLabelText("Edge Type")).toHaveValue("data-flow");

    fireEvent.change(screen.getByLabelText("Edge Type"), {
      target: { value: "trigger" },
    });

    expect(useDiagramStore.getState().edges[0]?.data?.edgeType).toBe("trigger");
  });

  it("updates an edge's label, protocol, and description through the store", () => {
    useDiagramStore.setState({
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
      selectedEdgeId: "e1",
    });
    render(<PropertiesPanel />);

    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "HTTPS" },
    });
    fireEvent.change(screen.getByLabelText("Protocol"), {
      target: { value: "http" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Primary request path" },
    });

    const edgeData = useDiagramStore.getState().edges[0]?.data;
    expect(edgeData?.label).toBe("HTTPS");
    expect(edgeData?.protocol).toBe("http");
    expect(edgeData?.description).toBe("Primary request path");
  });

  it("clears the protocol when reset to 'None'", () => {
    useDiagramStore.setState({
      edges: [
        {
          data: { edgeType: "data-flow", protocol: "http" },
          id: "e1",
          source: "a",
          target: "b",
        },
      ],
      selectedEdgeId: "e1",
    });
    render(<PropertiesPanel />);

    expect(screen.getByLabelText("Protocol")).toHaveValue("http");

    fireEvent.change(screen.getByLabelText("Protocol"), {
      target: { value: "" },
    });

    expect(useDiagramStore.getState().edges[0]?.data?.protocol).toBeUndefined();
  });

  it("defaults to a data-flow edge when the selected edge carries no data", () => {
    useDiagramStore.setState({
      edges: [
        {
          data: undefined,
          id: "e1",
          source: "a",
          target: "b",
        },
      ],
      selectedEdgeId: "e1",
    });
    render(<PropertiesPanel />);

    expect(screen.getByLabelText("Edge Type")).toHaveValue("data-flow");
  });

  it("prioritizes the node panel when both a node and an edge are selected", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "W", typeId: "worker" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
      selectedNodeId: "n1",
      selectedEdgeId: "e1",
    });
    render(<PropertiesPanel />);

    expect(screen.getByText("Node Properties")).toBeInTheDocument();
  });
});
