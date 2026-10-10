import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PALETTE_COLLAPSED_STORAGE_KEY } from "../../../lib/palette-preferences";
import { ServicePalette } from "./ServicePalette";

describe("ServicePalette", () => {
  beforeEach(() => {
    localStorage.clear();
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Workers" }));
    expect(onAddNode).toHaveBeenCalledWith("worker");
  });

  it("collapses and expands a category section", () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    const header = screen.getByRole("button", { name: "Compute" });
    expect(screen.getByRole("button", { name: "Workers" })).toBeVisible();

    fireEvent.click(header);
    expect(
      screen.queryByRole("button", { name: "Workers" }),
    ).not.toBeInTheDocument();

    fireEvent.click(header);
    expect(screen.getByRole("button", { name: "Workers" })).toBeVisible();
  });

  it("attaches the catalog typeId as drag transfer data", () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    const item = screen.getByRole("button", { name: "Workers" });
    const setData = vi.fn();
    fireEvent.dragStart(item, {
      dataTransfer: { effectAllowed: "", setData },
    });
    expect(setData).toHaveBeenCalledWith("application/cf-node-type", "worker");
  });

  it("shows the catalog description as visible text, linked for assistive technology", () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    const item = screen.getByRole("button", { name: "Workers" });
    const description = screen.getByText(
      "Cloudflare Workers serverless compute",
    );
    expect(item).toHaveAttribute("aria-describedby", description.id);
  });

  it("collapses and expands every category at once (Bug 3)", () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    // Starts from the Bug 32 seeded default (Compute expanded, everything else collapsed, see
    // "./palette-preferences.ts"), not "everything expanded" -- "Collapse all" is exercised
    // first to reach a known, fully-collapsed baseline regardless of that seed.
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(
      screen.queryByRole("button", { name: "Workers" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("D1 Database")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("button", { name: "Workers" })).toBeVisible();
    expect(screen.getByText("D1 Database")).toBeInTheDocument();
  });

  it("seeds Compute expanded and every other category collapsed on a first-ever visit (Bug 32)", () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Workers" })).toBeVisible();
    expect(screen.queryByText("D1 Database")).not.toBeInTheDocument();
  });

  it("persists a category toggle to localStorage and honors it on the next mount (Bug 32)", () => {
    const { unmount } = render(<ServicePalette onAddNode={vi.fn()} />);
    // Storage & Data starts collapsed by the seeded default; expand it.
    fireEvent.click(screen.getByRole("button", { name: "Storage & Data" }));
    expect(screen.getByText("D1 Database")).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(PALETTE_COLLAPSED_STORAGE_KEY) ?? "[]"),
    ).not.toContain("storage");
    unmount();

    render(<ServicePalette onAddNode={vi.fn()} />);
    expect(screen.getByText("D1 Database")).toBeInTheDocument();
  });

  it("persists collapse all/expand all to localStorage and honors it on the next mount (Bug 32)", () => {
    const { unmount } = render(<ServicePalette onAddNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(
      JSON.parse(localStorage.getItem(PALETTE_COLLAPSED_STORAGE_KEY) ?? "[]"),
    ).toContain("compute");
    unmount();

    render(<ServicePalette onAddNode={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "Workers" }),
    ).not.toBeInTheDocument();
  });

  it("honors a pre-existing stored preference on mount", () => {
    localStorage.setItem(
      PALETTE_COLLAPSED_STORAGE_KEY,
      JSON.stringify(["compute"]),
    );
    render(<ServicePalette onAddNode={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "Workers" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("D1 Database")).toBeInTheDocument();
  });
});
