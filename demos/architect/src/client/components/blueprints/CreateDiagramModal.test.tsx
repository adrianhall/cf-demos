import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Blueprint } from "../../../blueprints";
import * as mockXyflow from "../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockCreateDiagram } = vi.hoisted(() => ({
  mockCreateDiagram: vi.fn(),
}));
vi.mock("../../api/diagrams", () => ({ createDiagram: mockCreateDiagram }));

const { CreateDiagramModal } = await import("./CreateDiagramModal");

const SAMPLE_BLUEPRINT: Blueprint = {
  category: "Serverless",
  description: "A sample blueprint.",
  graphData: JSON.stringify({ edges: [], nodes: [] }),
  id: "sample",
  title: "Sample Blueprint",
};

describe("CreateDiagramModal", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    mockCreateDiagram.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, href: "" },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <CreateDiagramModal open={false} onClose={vi.fn()} blueprint={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("prefills the title/description from the selected blueprint", () => {
    render(
      <CreateDiagramModal
        open
        onClose={vi.fn()}
        blueprint={SAMPLE_BLUEPRINT}
      />,
    );
    expect(screen.getByLabelText("Title")).toHaveValue("Sample Blueprint");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "A sample blueprint.",
    );
    expect(screen.getByText("Serverless")).toBeInTheDocument();
  });

  it("defaults to 'Untitled Diagram' with an empty description for a blank canvas", () => {
    render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);
    expect(screen.getByLabelText("Title")).toHaveValue("Untitled Diagram");
    expect(screen.getByLabelText("Description")).toHaveValue("");
  });

  it("disables creation while the title is empty", () => {
    render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "  " },
    });
    expect(
      screen.getByRole("button", { name: "Create Diagram" }),
    ).toBeDisabled();
  });

  it("updates the description field as the user types", () => {
    render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "A blank diagram." },
    });
    expect(screen.getByLabelText("Description")).toHaveValue(
      "A blank diagram.",
    );
  });

  it("creates a diagram and navigates to its editor on success", async () => {
    mockCreateDiagram.mockResolvedValue({ id: "new-diagram-id" });

    render(
      <CreateDiagramModal
        open
        onClose={vi.fn()}
        blueprint={SAMPLE_BLUEPRINT}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Diagram" }));

    await waitFor(() =>
      expect(mockCreateDiagram).toHaveBeenCalledWith({
        blueprintId: "sample",
        description: "A sample blueprint.",
        title: "Sample Blueprint",
      }),
    );
    await waitFor(() =>
      expect(window.location.href).toBe("/app/diagram/new-diagram-id"),
    );
  });

  it("shows an error and re-enables the button when creation fails", async () => {
    mockCreateDiagram.mockRejectedValue(new Error("Blueprint not found."));

    render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Create Diagram" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Blueprint not found.",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Create Diagram" }),
    ).not.toBeDisabled();
  });

  it("closes when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<CreateDiagramModal open onClose={onClose} blueprint={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<CreateDiagramModal open onClose={onClose} blueprint={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when clicking the backdrop outside the dialog", () => {
    const onClose = vi.fn();
    render(<CreateDiagramModal open onClose={onClose} blueprint={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close when clicking inside the dialog", () => {
    const onClose = vi.fn();
    render(<CreateDiagramModal open onClose={onClose} blueprint={null} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
