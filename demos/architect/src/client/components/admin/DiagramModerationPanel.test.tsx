import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockDeleteAnyDiagram, mockGetAnyDiagram } = vi.hoisted(() => ({
  mockDeleteAnyDiagram: vi.fn(),
  mockGetAnyDiagram: vi.fn(),
}));
vi.mock("../../api/admin", () => ({
  deleteAnyDiagram: mockDeleteAnyDiagram,
  getAnyDiagram: mockGetAnyDiagram,
}));

const { DiagramModerationPanel } = await import("./DiagramModerationPanel");

const DIAGRAM = {
  description: "A test diagram",
  graphData: JSON.stringify({ edges: [], nodes: [] }),
  id: "11111111-1111-1111-1111-111111111111",
  title: "Reviewed Diagram",
};

describe("DiagramModerationPanel", () => {
  beforeEach(() => {
    mockGetAnyDiagram.mockReset();
    mockDeleteAnyDiagram.mockReset().mockResolvedValue(undefined);
  });

  it("loads and previews a diagram by id", async () => {
    mockGetAnyDiagram.mockResolvedValue(DIAGRAM);
    render(<DiagramModerationPanel />);

    fireEvent.change(screen.getByLabelText("Diagram id"), {
      target: { value: DIAGRAM.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(screen.getByText("Reviewed Diagram")).toBeInTheDocument(),
    );
    expect(screen.getByText("A test diagram")).toBeInTheDocument();
    expect(mockGetAnyDiagram).toHaveBeenCalledWith(DIAGRAM.id);
  });

  it("does nothing when submitted with a blank id", async () => {
    render(<DiagramModerationPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(mockGetAnyDiagram).not.toHaveBeenCalled();
  });

  it("shows an error message when the diagram cannot be loaded", async () => {
    mockGetAnyDiagram.mockRejectedValue(new Error("Diagram not found."));
    render(<DiagramModerationPanel />);

    fireEvent.change(screen.getByLabelText("Diagram id"), {
      target: { value: "missing-id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Diagram not found."),
    );
  });

  it("shows a generic message when the load failure is not an Error instance", async () => {
    mockGetAnyDiagram.mockRejectedValue("boom");
    render(<DiagramModerationPanel />);

    fireEvent.change(screen.getByLabelText("Diagram id"), {
      target: { value: "missing-id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load that diagram.",
      ),
    );
  });

  it("deletes the previewed diagram after confirming", async () => {
    mockGetAnyDiagram.mockResolvedValue(DIAGRAM);
    render(<DiagramModerationPanel />);

    fireEvent.change(screen.getByLabelText("Diagram id"), {
      target: { value: DIAGRAM.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByText("Reviewed Diagram")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete diagram" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Diagram deleted."),
    );
    expect(mockDeleteAnyDiagram).toHaveBeenCalledWith(DIAGRAM.id);
    expect(screen.queryByText("Reviewed Diagram")).not.toBeInTheDocument();
  });

  it("shows an error message when deletion fails", async () => {
    mockGetAnyDiagram.mockResolvedValue(DIAGRAM);
    mockDeleteAnyDiagram.mockRejectedValue(new Error("Diagram not found."));
    render(<DiagramModerationPanel />);

    fireEvent.change(screen.getByLabelText("Diagram id"), {
      target: { value: DIAGRAM.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByText("Reviewed Diagram")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete diagram" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Diagram not found."),
    );
  });

  it("shows a generic message when the delete failure is not an Error instance", async () => {
    mockGetAnyDiagram.mockResolvedValue(DIAGRAM);
    mockDeleteAnyDiagram.mockRejectedValue("boom");
    render(<DiagramModerationPanel />);

    fireEvent.change(screen.getByLabelText("Diagram id"), {
      target: { value: DIAGRAM.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByText("Reviewed Diagram")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete diagram" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not delete that diagram.",
      ),
    );
  });

  it("dismisses the confirmation dialog without deleting on cancel", async () => {
    mockGetAnyDiagram.mockResolvedValue(DIAGRAM);
    render(<DiagramModerationPanel />);

    fireEvent.change(screen.getByLabelText("Diagram id"), {
      target: { value: DIAGRAM.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByText("Reviewed Diagram")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete diagram" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockDeleteAnyDiagram).not.toHaveBeenCalled();
    expect(screen.getByText("Reviewed Diagram")).toBeInTheDocument();
  });
});
