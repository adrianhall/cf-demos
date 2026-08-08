import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BLUEPRINTS } from "../../../blueprints";
import * as mockXyflow from "../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { BlueprintGallery } = await import("./BlueprintGallery");

describe("BlueprintGallery", () => {
  it("renders a blank-canvas card and one card per blueprint", () => {
    render(<BlueprintGallery />);
    expect(
      screen.getByRole("button", { name: /Blank Canvas/ }),
    ).toBeInTheDocument();
    for (const blueprint of BLUEPRINTS) {
      expect(
        screen.getByRole("button", { name: new RegExp(blueprint.title) }),
      ).toBeInTheDocument();
    }
  });

  it("renders a filter tab for every distinct blueprint category, plus All", () => {
    render(<BlueprintGallery />);
    const categories = new Set(
      BLUEPRINTS.map((blueprint) => blueprint.category),
    );
    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
    for (const category of categories) {
      expect(screen.getByRole("tab", { name: category })).toBeInTheDocument();
    }
  });

  it("filters the grid to only the active category", () => {
    render(<BlueprintGallery />);
    fireEvent.click(screen.getByRole("tab", { name: "AI" }));

    const aiBlueprints = BLUEPRINTS.filter(
      (blueprint) => blueprint.category === "AI",
    );
    const otherBlueprints = BLUEPRINTS.filter(
      (blueprint) => blueprint.category !== "AI",
    );

    for (const blueprint of aiBlueprints) {
      expect(
        screen.getByRole("button", { name: new RegExp(blueprint.title) }),
      ).toBeInTheDocument();
    }
    for (const blueprint of otherBlueprints) {
      expect(
        screen.queryByRole("button", { name: new RegExp(blueprint.title) }),
      ).not.toBeInTheDocument();
    }
    // The always-visible blank canvas card is unaffected by the category filter.
    expect(
      screen.getByRole("button", { name: /Blank Canvas/ }),
    ).toBeInTheDocument();
  });

  it("opens the create modal for the blank canvas", () => {
    render(<BlueprintGallery />);
    fireEvent.click(screen.getByRole("button", { name: /Blank Canvas/ }));
    expect(
      screen.getByRole("dialog", { name: "Create New Diagram" }),
    ).toBeInTheDocument();
  });

  it("opens the create modal pre-filled for a clicked blueprint", () => {
    render(<BlueprintGallery />);
    const first = BLUEPRINTS[0];
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(first?.title ?? "") }),
    );
    expect(
      screen.getByRole("dialog", { name: first?.title }),
    ).toBeInTheDocument();
  });

  it("closes the create modal when cancelled", () => {
    render(<BlueprintGallery />);
    fireEvent.click(screen.getByRole("button", { name: /Blank Canvas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
