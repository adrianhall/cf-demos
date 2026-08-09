import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/admin/UserDirectoryTable", () => ({
  UserDirectoryTable: () => <div data-testid="user-directory-table" />,
}));
vi.mock("../components/admin/DiagramModerationPanel", () => ({
  DiagramModerationPanel: () => <div data-testid="diagram-moderation-panel" />,
}));

const { AdminView } = await import("./AdminView");

describe("AdminView", () => {
  it("renders the user directory and diagram moderation panel", () => {
    render(<AdminView />);

    expect(screen.getByText("Administration")).toBeInTheDocument();
    expect(screen.getByTestId("user-directory-table")).toBeInTheDocument();
    expect(screen.getByTestId("diagram-moderation-panel")).toBeInTheDocument();
  });
});
