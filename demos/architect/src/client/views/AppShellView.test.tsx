import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShellView } from "./AppShellView";

describe("AppShellView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows identity verification while the session is loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<AppShellView />);

    expect(screen.getByText("Verifying identity…")).toBeInTheDocument();
  });

  it("renders the verified email and admin marker after loading", async () => {
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
      expect(
        screen.getByText("admin@example.com (administrator)"),
      ).toBeInTheDocument(),
    );
  });

  it("renders the verified email with no admin marker for a non-administrator", async () => {
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
});
