import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// AppShellView's own tests cover only the header/identity/routing behavior it is directly
// responsible for; `DashboardView`'s and `EditorView`'s own behavior (including their real
// `fetch` calls) is already covered by their own test files (and `DiagramGrid.test.tsx`,
// `DiagramCanvas.test.tsx`). Stubbing both here keeps a `fetch` mocked for `GET /api/me` from
// also being asked to answer `DiagramGrid`'s `GET /api/diagrams` with the same response shape.
vi.mock("./DashboardView", () => ({
  DashboardView: () => <div data-testid="dashboard-view" />,
}));
vi.mock("./EditorView", () => ({
  EditorView: ({ diagramId }: { diagramId: string }) => (
    <div data-testid="editor-view" data-diagram-id={diagramId} />
  ),
}));
vi.mock("./AdminView", () => ({
  AdminView: () => <div data-testid="admin-view" />,
}));

const { AppShellView } = await import("./AppShellView");

describe("AppShellView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/app");
  });

  it("shows identity verification while the session is loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<AppShellView />);

    expect(screen.getByText("Verifying identity…")).toBeInTheDocument();
  });

  it("renders the verified email with an administrator badge after loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ email: "admin@example.com", isAdmin: true }),
            { status: 200 },
          ),
        ),
    );

    render(<AppShellView />);

    await waitFor(() =>
      expect(screen.getByText("admin@example.com")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("img", { name: "Administrator" }),
    ).toBeInTheDocument();
  });

  it("shows an Admin nav link only for the configured administrator", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ email: "admin@example.com", isAdmin: true }),
            { status: 200 },
          ),
        ),
    );

    render(<AppShellView />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute(
        "href",
        "/app/admin",
      ),
    );
  });

  it("hides the Admin nav link for a non-administrator", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ email: "alice@example.com", isAdmin: false }),
            { status: 200 },
          ),
        ),
    );

    render(<AppShellView />);

    await waitFor(() =>
      expect(screen.getByText("alice@example.com")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("link", { name: "Admin" }),
    ).not.toBeInTheDocument();
  });

  it("renders the verified email with no administrator badge for a non-administrator", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ email: "alice@example.com", isAdmin: false }),
            { status: 200 },
          ),
        ),
    );

    render(<AppShellView />);

    await waitFor(() =>
      expect(screen.getByText("alice@example.com")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("img", { name: "Administrator" }),
    ).not.toBeInTheDocument();
  });

  it("renders a logout control unconditionally, even while loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<AppShellView />);

    expect(screen.getByRole("link", { name: "Sign out" })).toHaveAttribute(
      "href",
      "/cdn-cgi/access/logout",
    );
  });

  it("renders a dark mode toggle in the header unconditionally, even while loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<AppShellView />);

    expect(screen.getByTitle("Toggle dark mode")).toBeInTheDocument();
  });

  it("shows the error message when identity verification fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Access expired." }), {
          status: 401,
        }),
      ),
    );

    render(<AppShellView />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Access expired."),
    );
  });

  it("renders the dashboard view at /app", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    window.history.pushState({}, "", "/app");

    render(<AppShellView />);

    expect(screen.getByTestId("dashboard-view")).toBeInTheDocument();
  });

  it("renders the dashboard view for an unrecognized nested /app path", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    window.history.pushState({}, "", "/app/diagrams/example");

    render(<AppShellView />);

    expect(screen.getByTestId("dashboard-view")).toBeInTheDocument();
  });

  it("renders the editor view with the parsed diagram id at /app/diagram/:id", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    window.history.pushState({}, "", "/app/diagram/abc-123");

    render(<AppShellView />);

    expect(screen.getByTestId("editor-view")).toHaveAttribute(
      "data-diagram-id",
      "abc-123",
    );
  });

  it("renders the admin view at /app/admin for the configured administrator", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ email: "admin@example.com", isAdmin: true }),
            { status: 200 },
          ),
        ),
    );
    window.history.pushState({}, "", "/app/admin");

    render(<AppShellView />);

    await waitFor(() =>
      expect(screen.getByTestId("admin-view")).toBeInTheDocument(),
    );
  });

  it("shows a not-allowed message at /app/admin for a non-administrator", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ email: "alice@example.com", isAdmin: false }),
            { status: 200 },
          ),
        ),
    );
    window.history.pushState({}, "", "/app/admin");

    render(<AppShellView />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This page is only available to this demo's configured administrator.",
      ),
    );
    expect(screen.queryByTestId("admin-view")).not.toBeInTheDocument();
  });

  it("shows a loading message at /app/admin while identity verification is pending", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    window.history.pushState({}, "", "/app/admin");

    render(<AppShellView />);

    expect(screen.getAllByText("Verifying identity…")).toHaveLength(2);
    expect(screen.queryByTestId("admin-view")).not.toBeInTheDocument();
  });

  it("applies the editor layout modifier only for the editor view", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    window.history.pushState({}, "", "/app/diagram/abc-123");

    const { container } = render(<AppShellView />);

    expect(container.querySelector("main")).toHaveClass(
      "app-shell__main--editor",
    );
  });
});
