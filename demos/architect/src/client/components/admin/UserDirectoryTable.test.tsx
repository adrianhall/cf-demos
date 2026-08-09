import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "../../api/admin";

const { mockListUsers } = vi.hoisted(() => ({ mockListUsers: vi.fn() }));
vi.mock("../../api/admin", () => ({ listUsers: mockListUsers }));

const { UserDirectoryTable } = await import("./UserDirectoryTable");

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    diagramCount: 0,
    displayName: null,
    email: "alice@example.com",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("UserDirectoryTable", () => {
  beforeEach(() => {
    mockListUsers.mockReset();
  });

  it("shows a loading state before the directory resolves", () => {
    mockListUsers.mockReturnValue(new Promise(() => {}));
    render(<UserDirectoryTable />);
    expect(screen.getByText("Loading the user directory…")).toBeInTheDocument();
  });

  it("renders a row per directory entry with its diagram count", async () => {
    mockListUsers.mockResolvedValue({
      limit: 20,
      offset: 0,
      total: 1,
      users: [user({ diagramCount: 3, email: "alice@example.com" })],
    });

    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(screen.getByText("alice@example.com")).toBeInTheDocument(),
    );
    const row = screen.getByText("alice@example.com").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("3")).toBeInTheDocument();
  });

  it("renders an em dash for a null display name", async () => {
    mockListUsers.mockResolvedValue({
      limit: 20,
      offset: 0,
      total: 1,
      users: [user({ displayName: null })],
    });

    render(<UserDirectoryTable />);

    await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
  });

  it("shows an empty state when no identity has ever signed in", async () => {
    mockListUsers.mockResolvedValue({
      limit: 20,
      offset: 0,
      total: 0,
      users: [],
    });

    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(
        screen.getByText("No identities have signed in yet."),
      ).toBeInTheDocument(),
    );
  });

  it("shows an error message when loading fails", async () => {
    mockListUsers.mockRejectedValue(
      new Error("Could not load the user directory."),
    );

    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load the user directory.",
      ),
    );
  });

  it("disables Previous on the first page and Next when every row is shown", async () => {
    mockListUsers.mockResolvedValue({
      limit: 20,
      offset: 0,
      total: 1,
      users: [user()],
    });

    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(screen.getByText("alice@example.com")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("requests the next page with an advanced offset", async () => {
    mockListUsers.mockResolvedValueOnce({
      limit: 20,
      offset: 0,
      total: 25,
      users: [user({ email: "page1@example.com" })],
    });
    mockListUsers.mockResolvedValueOnce({
      limit: 20,
      offset: 20,
      total: 25,
      users: [user({ email: "page2@example.com" })],
    });

    render(<UserDirectoryTable />);

    await waitFor(() =>
      expect(screen.getByText("page1@example.com")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(screen.getByText("page2@example.com")).toBeInTheDocument(),
    );
    expect(mockListUsers).toHaveBeenLastCalledWith({ limit: 20, offset: 20 });

    mockListUsers.mockResolvedValueOnce({
      limit: 20,
      offset: 0,
      total: 25,
      users: [user({ email: "page1@example.com" })],
    });
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));

    await waitFor(() =>
      expect(screen.getByText("page1@example.com")).toBeInTheDocument(),
    );
    expect(mockListUsers).toHaveBeenLastCalledWith({ limit: 20, offset: 0 });
  });
});
