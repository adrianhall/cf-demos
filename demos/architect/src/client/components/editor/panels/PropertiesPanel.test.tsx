import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CATEGORY_COLORS } from "../../../../catalog";
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
