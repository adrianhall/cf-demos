import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagramSummary } from "../../api/diagrams";
import * as mockXyflow from "../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockListSharedWithMe } = vi.hoisted(() => ({
  mockListSharedWithMe: vi.fn(),
}));
vi.mock("../../api/collaborators", () => ({
  listSharedWithMe: mockListSharedWithMe,
}));

const { SharedWithMeGrid } = await import("./SharedWithMeGrid");

function diagram(overrides: Partial<DiagramSummary> = {}): DiagramSummary {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    description: null,
    graphData: JSON.stringify({ edges: [], nodes: [] }),
    id: "d1",
    ownerEmail: "owner@example.com",
    title: "Shared Diagram",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("SharedWithMeGrid", () => {
  beforeEach(() => {
    mockListSharedWithMe.mockReset();
  });

  it("renders an accessible heading", async () => {
    mockListSharedWithMe.mockResolvedValue([]);
    render(<SharedWithMeGrid />);
    expect(
      screen.getByRole("heading", { name: "Shared with me" }),
    ).toBeInTheDocument();
  });

  it("shows a loading state before the list resolves", () => {
    mockListSharedWithMe.mockReturnValue(new Promise(() => {}));
    render(<SharedWithMeGrid />);
    expect(screen.getByText("Loading shared diagrams…")).toBeInTheDocument();
  });

  it("shows an empty state when nothing has been shared", async () => {
    mockListSharedWithMe.mockResolvedValue([]);
    render(<SharedWithMeGrid />);
    await waitFor(() =>
      expect(
        screen.getByText("No one has shared a diagram with you yet."),
      ).toBeInTheDocument(),
    );
  });

  it("shows an error state when the list request fails", async () => {
    mockListSharedWithMe.mockRejectedValue(new Error("Network error"));
    render(<SharedWithMeGrid />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Network error"),
    );
  });

  it("falls back to a generic message when the list request fails with a non-Error rejection", async () => {
    mockListSharedWithMe.mockRejectedValue("boom");
    render(<SharedWithMeGrid />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load diagrams shared with you.",
      ),
    );
  });

  it("renders a card per shared diagram, linking to its editor and showing an owner badge", async () => {
    mockListSharedWithMe.mockResolvedValue([
      diagram({ id: "d1", ownerEmail: "alice@example.com", title: "First" }),
    ]);
    render(<SharedWithMeGrid />);

    await waitFor(() => expect(screen.getByText("First")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /First/ })).toHaveAttribute(
      "href",
      "/app/diagram/d1",
    );
    expect(screen.getByText("Shared by alice@example.com")).toBeInTheDocument();
  });

  it("renders no overflow menu on a shared card", async () => {
    mockListSharedWithMe.mockResolvedValue([diagram()]);
    render(<SharedWithMeGrid />);

    await waitFor(() =>
      expect(screen.getByText("Shared Diagram")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /Actions for/ }),
    ).not.toBeInTheDocument();
  });
});
