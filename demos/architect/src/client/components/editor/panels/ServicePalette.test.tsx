import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServicePalette } from "./ServicePalette";

describe("ServicePalette", () => {
  it("renders every catalog category", () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    expect(screen.getByText("Compute")).toBeInTheDocument();
    expect(screen.getByText("Storage & Data")).toBeInTheDocument();
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("filters items by search term across categories", () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search services"), {
      target: { value: "d1" },
    });
    expect(screen.getByText("D1 Database")).toBeInTheDocument();
    expect(screen.queryByText("Workers KV")).not.toBeInTheDocument();
  });

  it("calls onAddNode with the item's typeId when clicked", () => {
    const onAddNode = vi.fn();
    render(<ServicePalette onAddNode={onAddNode} />);
    fireEvent.click(screen.getByRole("button", { name: /Workers$/ }));
    expect(onAddNode).toHaveBeenCalledWith("worker");
  });

  it("collapses and expands a category section", () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    const header = screen.getByRole("button", { name: "Compute" });
    expect(screen.getByRole("button", { name: /Workers$/ })).toBeVisible();

    fireEvent.click(header);
    expect(
      screen.queryByRole("button", { name: /Workers$/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(header);
    expect(screen.getByRole("button", { name: /Workers$/ })).toBeVisible();
  });

  it("attaches the catalog typeId as drag transfer data", () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    const item = screen.getByRole("button", { name: /Workers$/ });
    const setData = vi.fn();
    fireEvent.dragStart(item, {
      dataTransfer: { effectAllowed: "", setData },
    });
    expect(setData).toHaveBeenCalledWith("application/cf-node-type", "worker");
  });
});
