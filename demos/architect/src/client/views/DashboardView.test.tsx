import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/dashboard/DiagramGrid", () => ({
  DiagramGrid: () => <div data-testid="diagram-grid" />,
}));
vi.mock("../components/dashboard/SharedWithMeGrid", () => ({
  SharedWithMeGrid: () => <div data-testid="shared-with-me-grid" />,
}));

const { DashboardView } = await import("./DashboardView");

describe("DashboardView", () => {
  it("renders the owner's own diagram grid followed by the shared-with-me section", () => {
    render(<DashboardView />);
    expect(screen.getByTestId("diagram-grid")).toBeInTheDocument();
    expect(screen.getByTestId("shared-with-me-grid")).toBeInTheDocument();
  });
});
