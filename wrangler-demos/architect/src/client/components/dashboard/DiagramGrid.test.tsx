import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagramSummary } from "../../api/diagrams";
import * as mockXyflow from "../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockDeleteDiagram, mockDuplicateDiagram, mockListDiagrams } =
  vi.hoisted(() => ({
    mockDeleteDiagram: vi.fn(),
    mockDuplicateDiagram: vi.fn(),
    mockListDiagrams: vi.fn(),
  }));
vi.mock("../../api/diagrams", () => ({
  deleteDiagram: mockDeleteDiagram,
  duplicateDiagram: mockDuplicateDiagram,
  listDiagrams: mockListDiagrams,
}));

const { DiagramGrid } = await import("./DiagramGrid");

function diagram(overrides: Partial<DiagramSummary> = {}): DiagramSummary {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    description: null,
    graphData: JSON.stringify({ edges: [], nodes: [] }),
    id: "d1",
    ownerEmail: "alice@example.com",
    title: "My Diagram",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("DiagramGrid", () => {
  beforeEach(() => {
    mockListDiagrams.mockReset();
    mockDeleteDiagram.mockReset().mockResolvedValue(undefined);
    mockDuplicateDiagram.mockReset();
  });

  it("shows a loading state before the list resolves", () => {
    mockListDiagrams.mockReturnValue(new Promise(() => {}));
    render(<DiagramGrid />);
    expect(screen.getByText("Loading your diagrams…")).toBeInTheDocument();
  });

  it("shows an empty state with a create link when there are no diagrams", async () => {
    mockListDiagrams.mockResolvedValue([]);
    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByText("No diagrams yet")).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "+ New Diagram" })).toHaveAttribute(
      "href",
      "/blueprints",
    );
  });

  it("renders a card per diagram, linking to its editor", async () => {
    mockListDiagrams.mockResolvedValue([diagram({ id: "d1", title: "First" })]);
    render(<DiagramGrid />);

    await waitFor(() => expect(screen.getByText("First")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /First/ })).toHaveAttribute(
      "href",
      "/app/diagram/d1",
    );
  });

  it("shows a relative 'Updated' timestamp with the exact dates as a hover tooltip", async () => {
    // Fixed offsets from the real clock (rather than fake timers, which testing-library's
    // `waitFor` polling does not advance on its own) so "2 days ago" is unambiguous without
    // landing on a unit boundary.
    const createdAt = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const updatedAt = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    mockListDiagrams.mockResolvedValue([
      diagram({ createdAt, id: "d1", title: "First", updatedAt }),
    ]);
    const { container } = render(<DiagramGrid />);
    await waitFor(() => expect(screen.getByText("First")).toBeInTheDocument());

    const timestamp = container.querySelector(".diagram-card__timestamp");
    expect(timestamp?.tagName).toBe("TIME");
    expect(timestamp).toHaveAttribute("dateTime", updatedAt);
    expect(timestamp?.textContent).toContain("Updated 2 days ago");
    expect(timestamp).toHaveAttribute(
      "title",
      expect.stringContaining("Created"),
    );
    expect(timestamp).toHaveAttribute(
      "title",
      expect.stringContaining("Updated"),
    );
  });

  it("shows an error message when loading fails", async () => {
    mockListDiagrams.mockRejectedValue(
      new Error("Could not load your diagrams."),
    );
    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load your diagrams.",
      ),
    );
  });

  it("duplicates a diagram and refreshes the list", async () => {
    const original = diagram({ id: "d1", title: "Original" });
    mockListDiagrams
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([
        original,
        diagram({ id: "d2", title: "Original (copy)" }),
      ]);
    mockDuplicateDiagram.mockResolvedValue(
      diagram({ id: "d2", title: "Original (copy)" }),
    );

    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByText("Original")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Original" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() =>
      expect(mockDuplicateDiagram).toHaveBeenCalledWith(original),
    );
    await waitFor(() =>
      expect(screen.getByText("Original (copy)")).toBeInTheDocument(),
    );
  });

  it("deletes a diagram after confirmation", async () => {
    mockListDiagrams.mockResolvedValue([
      diagram({ id: "d1", title: "To Delete" }),
    ]);
    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByText("To Delete")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for To Delete" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockDeleteDiagram).toHaveBeenCalledWith("d1"));
    await waitFor(() =>
      expect(screen.queryByText("To Delete")).not.toBeInTheDocument(),
    );
  });

  it("keeps the diagram when deletion is cancelled", async () => {
    mockListDiagrams.mockResolvedValue([
      diagram({ id: "d1", title: "Keep Me" }),
    ]);
    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByText("Keep Me")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Keep Me" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockDeleteDiagram).not.toHaveBeenCalled();
    expect(screen.getByText("Keep Me")).toBeInTheDocument();
  });

  it("shows a generic message when the load failure is not an Error instance", async () => {
    mockListDiagrams.mockRejectedValue("boom");
    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load your diagrams.",
      ),
    );
  });

  it("closes the card menu on Escape", async () => {
    mockListDiagrams.mockResolvedValue([
      diagram({ id: "d1", title: "Menu Test" }),
    ]);
    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByText("Menu Test")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Menu Test" }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("leaves the card menu open on a non-Escape key", async () => {
    mockListDiagrams.mockResolvedValue([
      diagram({ id: "d1", title: "Menu Test" }),
    ]);
    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByText("Menu Test")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Menu Test" }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes the card menu when clicking outside it", async () => {
    mockListDiagrams.mockResolvedValue([
      diagram({ id: "d1", title: "Menu Test" }),
    ]);
    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByText("Menu Test")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Menu Test" }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("leaves the card menu open when clicking inside it", async () => {
    mockListDiagrams.mockResolvedValue([
      diagram({ id: "d1", title: "Menu Test" }),
    ]);
    render(<DiagramGrid />);
    await waitFor(() =>
      expect(screen.getByText("Menu Test")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Menu Test" }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
