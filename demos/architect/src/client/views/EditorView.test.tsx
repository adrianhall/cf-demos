import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockGetDiagram } = vi.hoisted(() => ({ mockGetDiagram: vi.fn() }));
vi.mock("../api/diagrams", () => ({
  getDiagram: mockGetDiagram,
  saveDiagramGraph: vi.fn(),
  updateDiagram: vi.fn(),
}));

const { EditorView } = await import("./EditorView");

describe("EditorView", () => {
  it("renders the diagram canvas for the given diagram id, wrapped in a ReactFlowProvider", () => {
    mockGetDiagram.mockReturnValue(new Promise(() => {}));

    render(<EditorView diagramId="abc-123" />);

    expect(mockGetDiagram).toHaveBeenCalledWith("abc-123");
    expect(screen.getByText("Loading diagram…")).toBeInTheDocument();
  });
});
