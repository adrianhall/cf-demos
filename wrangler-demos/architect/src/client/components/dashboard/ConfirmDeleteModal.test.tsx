import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";

describe("ConfirmDeleteModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ConfirmDeleteModal
        open={false}
        diagramTitle="My Diagram"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the diagram title in the confirmation copy", () => {
    render(
      <ConfirmDeleteModal
        open
        diagramTitle="My Diagram"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/My Diagram/)).toBeInTheDocument();
  });

  it("calls onConfirm when Delete is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteModal
        open
        diagramTitle="X"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteModal
        open
        diagramTitle="X"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when the backdrop is clicked outside the dialog", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteModal
        open
        diagramTitle="X"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
