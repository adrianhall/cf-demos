import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityState } from "../../../hooks/useIdentity";

const {
  mockAddCollaborator,
  mockListCollaborators,
  mockRemoveCollaborator,
  mockUseIdentity,
} = vi.hoisted(() => ({
  mockAddCollaborator: vi.fn(),
  mockListCollaborators: vi.fn(),
  mockRemoveCollaborator: vi.fn(),
  mockUseIdentity: vi.fn(),
}));
vi.mock("../../../api/collaborators", () => ({
  addCollaborator: mockAddCollaborator,
  listCollaborators: mockListCollaborators,
  removeCollaborator: mockRemoveCollaborator,
}));
vi.mock("../../../hooks/useIdentity", () => ({
  useIdentity: mockUseIdentity,
}));

const { CollaboratorsModal } = await import("./CollaboratorsModal");

/** Identity state for a signed-in, non-loading owner or collaborator. */
function identityFor(email: string): IdentityState {
  return { email, error: null, isAdmin: false, loading: false };
}

describe("CollaboratorsModal", () => {
  beforeEach(() => {
    mockAddCollaborator.mockReset();
    mockListCollaborators.mockReset();
    mockRemoveCollaborator.mockReset();
    mockUseIdentity
      .mockReset()
      .mockReturnValue(identityFor("owner@example.com"));
  });

  it("renders nothing when closed", () => {
    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open={false}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists current collaborators once loaded", async () => {
    mockListCollaborators.mockResolvedValue([
      {
        addedAt: "2026-01-01T00:00:00.000Z",
        addedBy: "owner@example.com",
        diagramId: "d1",
        displayName: null,
        email: "colleague@example.com",
      },
    ]);

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("colleague@example.com")).toBeInTheDocument(),
    );
    expect(mockListCollaborators).toHaveBeenCalledWith("d1");
  });

  it("shows an empty state with no collaborators", async () => {
    mockListCollaborators.mockResolvedValue([]);

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("No collaborators yet.")).toBeInTheDocument(),
    );
  });

  it("shows an error state when the list request fails", async () => {
    mockListCollaborators.mockRejectedValue(new Error("Network error"));

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Network error"),
    );
  });

  it("falls back to a generic message when the list request fails with a non-Error rejection", async () => {
    mockListCollaborators.mockRejectedValue("boom");

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load collaborators.",
      ),
    );
  });

  it("shows the owner a Remove button on every row and an add-by-email form", async () => {
    mockUseIdentity.mockReturnValue(identityFor("owner@example.com"));
    mockListCollaborators.mockResolvedValue([
      {
        addedAt: "2026-01-01T00:00:00.000Z",
        addedBy: "owner@example.com",
        diagramId: "d1",
        displayName: null,
        email: "colleague@example.com",
      },
    ]);

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByLabelText("Add collaborator by email"),
    ).toBeInTheDocument();
  });

  it("shows a collaborator a Leave button on their own row only, and no add-by-email form", async () => {
    mockUseIdentity.mockReturnValue(identityFor("colleague@example.com"));
    mockListCollaborators.mockResolvedValue([
      {
        addedAt: "2026-01-01T00:00:00.000Z",
        addedBy: "owner@example.com",
        diagramId: "d1",
        displayName: null,
        email: "colleague@example.com",
      },
      {
        addedAt: "2026-01-01T00:00:00.000Z",
        addedBy: "owner@example.com",
        diagramId: "d1",
        displayName: null,
        email: "other-collaborator@example.com",
      },
    ]);

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument(),
    );
    // Only one row (the viewer's own) gets a control -- the other collaborator's row is
    // view-only for a non-owner viewer.
    expect(screen.getAllByRole("button", { name: "Leave" })).toHaveLength(1);
    expect(
      screen.queryByLabelText("Add collaborator by email"),
    ).not.toBeInTheDocument();
  });

  it("removes a collaborator and reloads the list", async () => {
    mockUseIdentity.mockReturnValue(identityFor("owner@example.com"));
    mockListCollaborators
      .mockResolvedValueOnce([
        {
          addedAt: "2026-01-01T00:00:00.000Z",
          addedBy: "owner@example.com",
          diagramId: "d1",
          displayName: null,
          email: "colleague@example.com",
        },
      ])
      .mockResolvedValueOnce([]);
    mockRemoveCollaborator.mockResolvedValue(undefined);

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(mockRemoveCollaborator).toHaveBeenCalledWith(
        "d1",
        "colleague@example.com",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("No collaborators yet.")).toBeInTheDocument(),
    );
  });

  it("adds a collaborator by email and reloads the list", async () => {
    mockUseIdentity.mockReturnValue(identityFor("owner@example.com"));
    mockListCollaborators.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        addedAt: "2026-01-01T00:00:00.000Z",
        addedBy: "owner@example.com",
        diagramId: "d1",
        displayName: null,
        email: "colleague@example.com",
      },
    ]);
    mockAddCollaborator.mockResolvedValue({
      addedAt: "2026-01-01T00:00:00.000Z",
      addedBy: "owner@example.com",
      diagramId: "d1",
      displayName: null,
      email: "colleague@example.com",
    });

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByLabelText("Add collaborator by email"));
    fireEvent.change(screen.getByLabelText("Add collaborator by email"), {
      target: { value: "colleague@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mockAddCollaborator).toHaveBeenCalledWith(
        "d1",
        "colleague@example.com",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("colleague@example.com")).toBeInTheDocument(),
    );
  });

  it("shows an inline validation error from a rejected add-by-email attempt", async () => {
    mockUseIdentity.mockReturnValue(identityFor("owner@example.com"));
    mockListCollaborators.mockResolvedValue([]);
    mockAddCollaborator.mockRejectedValue(
      new Error(
        "That person needs to sign in to Architect at least once first.",
      ),
    );

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByLabelText("Add collaborator by email"));
    fireEvent.change(screen.getByLabelText("Add collaborator by email"), {
      target: { value: "stranger@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That person needs to sign in to Architect at least once first.",
      ),
    );
  });

  it("does not submit an add request for a whitespace-only email", async () => {
    mockUseIdentity.mockReturnValue(identityFor("owner@example.com"));
    mockListCollaborators.mockResolvedValue([]);

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByLabelText("Add collaborator by email"));
    const input = screen.getByLabelText("Add collaborator by email");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(mockAddCollaborator).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when adding a collaborator fails with a non-Error rejection", async () => {
    mockUseIdentity.mockReturnValue(identityFor("owner@example.com"));
    mockListCollaborators.mockResolvedValue([]);
    mockAddCollaborator.mockRejectedValue("boom");

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByLabelText("Add collaborator by email"));
    fireEvent.change(screen.getByLabelText("Add collaborator by email"), {
      target: { value: "stranger@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not add collaborator.",
      ),
    );
  });

  it("closes the modal", async () => {
    mockListCollaborators.mockResolvedValue([]);
    const onClose = vi.fn();

    render(
      <CollaboratorsModal
        diagramId="d1"
        ownerEmail="owner@example.com"
        open
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByRole("dialog"));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });
});
