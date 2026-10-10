import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockGetDiagram } = vi.hoisted(() => ({ mockGetDiagram: vi.fn() }));
vi.mock("../api/diagrams", () => ({
  getDiagram: mockGetDiagram,
  saveDiagramGraph: vi.fn(),
  updateDiagram: vi.fn(),
}));

const { mockGetSharedDiagram } = vi.hoisted(() => ({
  mockGetSharedDiagram: vi.fn(),
}));
vi.mock("../api/shares", () => ({
  createShare: vi.fn(),
  getShareStatus: vi.fn(),
  getSharedDiagram: mockGetSharedDiagram,
  revokeShare: vi.fn(),
}));

const { ShareView } = await import("./ShareView");

const EMPTY_GRAPH = JSON.stringify({
  edges: [],
  nodes: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});

describe("ShareView", () => {
  it("shows a loading state before the share fetch resolves", () => {
    mockGetSharedDiagram.mockReturnValue(new Promise(() => {}));

    render(<ShareView token="tok" />);

    expect(screen.getByText("Loading shared diagram…")).toBeInTheDocument();
  });

  it("renders the shared diagram read-only, with a banner and no owner-authenticated fetch", async () => {
    mockGetSharedDiagram.mockResolvedValue({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "shared-d1",
      title: "Shared Diagram",
    });

    render(<ShareView token="tok" />);

    await waitFor(() =>
      expect(screen.getByTestId("react-flow")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("You\u2019re viewing a shared diagram, read-only."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Create your own diagram/u }),
    ).toHaveAttribute("href", "/app");
    expect(mockGetDiagram).not.toHaveBeenCalled();
    expect(mockGetSharedDiagram).toHaveBeenCalledWith("tok");
  });

  it("shows an error and a way back when the token is unknown or revoked", async () => {
    mockGetSharedDiagram.mockRejectedValue(
      new Error("Share link not found or revoked."),
    );

    render(<ShareView token="missing" />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Share link not found or revoked.",
      ),
    );
    expect(
      screen.getByRole("link", { name: "Go to Architect" }),
    ).toHaveAttribute("href", "/");
  });

  it("falls back to a generic error message for a non-Error rejection", async () => {
    mockGetSharedDiagram.mockRejectedValue("boom");

    render(<ShareView token="missing" />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Share link not found or revoked.",
      ),
    );
  });

  it("ignores a share fetch that resolves after the component has unmounted", async () => {
    let resolveShare!: (value: {
      description: string;
      graphData: string;
      id: string;
      title: string;
    }) => void;
    mockGetSharedDiagram.mockReturnValue(
      new Promise((resolve) => {
        resolveShare = resolve;
      }),
    );

    const { unmount } = render(<ShareView token="tok" />);
    unmount();

    resolveShare({
      description: "",
      graphData: EMPTY_GRAPH,
      id: "shared-d1",
      title: "Shared Diagram",
    });
    await Promise.resolve();
  });

  it("ignores a share fetch that rejects after the component has unmounted", async () => {
    let rejectShare!: (reason: unknown) => void;
    mockGetSharedDiagram.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectShare = reject;
      }),
    );

    const { unmount } = render(<ShareView token="tok" />);
    unmount();

    rejectShare(new Error("too late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
