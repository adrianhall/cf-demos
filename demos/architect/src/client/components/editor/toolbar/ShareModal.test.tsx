import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateShare, mockGetShareStatus, mockRevokeShare } = vi.hoisted(
  () => ({
    mockCreateShare: vi.fn(),
    mockGetShareStatus: vi.fn(),
    mockRevokeShare: vi.fn(),
  }),
);
vi.mock("../../../api/shares", () => ({
  createShare: mockCreateShare,
  getShareStatus: mockGetShareStatus,
  revokeShare: mockRevokeShare,
}));

const { ShareModal } = await import("./ShareModal");

describe("ShareModal", () => {
  beforeEach(() => {
    mockGetShareStatus.mockReset();
    mockCreateShare.mockReset();
    mockRevokeShare.mockReset();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders nothing when closed", () => {
    render(<ShareModal diagramId="d1" open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a create-link prompt when no share is active", async () => {
    mockGetShareStatus.mockResolvedValue({ active: false, createdAt: null });

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create link" }),
      ).toBeInTheDocument(),
    );
  });

  it("creates a share and reveals its one-time URL with a copy button", async () => {
    mockGetShareStatus.mockResolvedValue({ active: false, createdAt: null });
    mockCreateShare.mockResolvedValue({
      createdAt: "2026-01-01T00:00:00.000Z",
      token: "t".repeat(43),
      url: "https://architect.example/s/ttt",
    });

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Create link" }));

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Share link")).toHaveValue(
        "https://architect.example/s/ttt",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "https://architect.example/s/ttt",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copied!" }),
      ).toBeInTheDocument(),
    );
  });

  it("revokes a just-created link directly from the revealed state", async () => {
    mockGetShareStatus.mockResolvedValue({ active: false, createdAt: null });
    mockCreateShare.mockResolvedValue({
      createdAt: "2026-01-01T00:00:00.000Z",
      token: "t".repeat(43),
      url: "https://architect.example/s/ttt",
    });
    mockRevokeShare.mockResolvedValue(undefined);

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Create link" }));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => screen.getByLabelText("Share link"));

    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create link" }),
      ).toBeInTheDocument(),
    );
    expect(mockRevokeShare).toHaveBeenCalledWith("d1");
  });

  it("shows an active-but-hidden state when a share already exists on open", async () => {
    mockGetShareStatus.mockResolvedValue({
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(
        screen.getByText(/A read-only link is active for this diagram/u),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Generate new link" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoke link" }),
    ).toBeInTheDocument();
  });

  it("revokes an active share and returns to the inactive state", async () => {
    mockGetShareStatus.mockResolvedValue({
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    mockRevokeShare.mockResolvedValue(undefined);

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Revoke link" }));

    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create link" }),
      ).toBeInTheDocument(),
    );
    expect(mockRevokeShare).toHaveBeenCalledWith("d1");
  });

  it("generates a new link from the active state, revoking the old one", async () => {
    mockGetShareStatus.mockResolvedValue({
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    mockCreateShare.mockResolvedValue({
      createdAt: "2026-01-02T00:00:00.000Z",
      token: "u".repeat(43),
      url: "https://architect.example/s/uuu",
    });

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);
    await waitFor(() =>
      screen.getByRole("button", { name: "Generate new link" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Generate new link" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Share link")).toHaveValue(
        "https://architect.example/s/uuu",
      ),
    );
  });

  it("shows an error state when the status request fails", async () => {
    mockGetShareStatus.mockRejectedValue(new Error("Network error"));

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Network error"),
    );
  });

  it("shows an error state when creating a link fails", async () => {
    mockGetShareStatus.mockResolvedValue({ active: false, createdAt: null });
    mockCreateShare.mockRejectedValue(new Error("Could not create link."));

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Create link" }));

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not create link.",
      ),
    );
  });

  it("falls back to a generic message when revoking fails with a non-Error rejection", async () => {
    mockGetShareStatus.mockResolvedValue({
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    mockRevokeShare.mockRejectedValue("boom");

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Revoke link" }));

    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not revoke link.",
      ),
    );
  });

  it("shows a transient busy label while a revoke request is in flight", async () => {
    mockGetShareStatus.mockResolvedValue({
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    let resolveRevoke!: () => void;
    mockRevokeShare.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRevoke = resolve;
      }),
    );

    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Revoke link" }));

    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revoking…" })).toBeDisabled(),
    );

    resolveRevoke();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create link" }),
      ).toBeInTheDocument(),
    );
  });

  it("closes via the close button and the backdrop", async () => {
    mockGetShareStatus.mockResolvedValue({ active: false, createdAt: null });
    const onClose = vi.fn();

    render(<ShareModal diagramId="d1" open onClose={onClose} />);
    await waitFor(() => screen.getByRole("button", { name: "Create link" }));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
