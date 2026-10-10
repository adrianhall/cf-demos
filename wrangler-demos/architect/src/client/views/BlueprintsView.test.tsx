import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The gallery's own behavior (filtering, the create modal, previews) is covered by
// `../components/blueprints/BlueprintGallery.test.tsx`; these tests are about the page's shell,
// so the gallery is stubbed to keep `@xyflow/react`'s thumbnail previews out of jsdom.
vi.mock("../components/blueprints/BlueprintGallery", () => ({
  BlueprintGallery: () => <div data-testid="blueprint-gallery" />,
}));

const { BlueprintsView } = await import("./BlueprintsView");

/** Stub `GET /api/me` with a response, or leave it pending. */
function stubIdentity(response?: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => (response ? Promise.resolve(response) : new Promise(() => {}))),
  );
}

/** A successful `GET /api/me` body. */
function identityResponse(email: string, isAdmin: boolean) {
  return new Response(JSON.stringify({ email, isAdmin }), { status: 200 });
}

describe("BlueprintsView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the gallery intro and the gallery itself", () => {
    stubIdentity();

    render(<BlueprintsView />);

    expect(
      screen.getByRole("heading", { name: "Start a new diagram" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("blueprint-gallery")).toBeInTheDocument();
  });

  it("renders the shared banner rather than its own ad-hoc header (Bug 34)", () => {
    stubIdentity();

    const { container } = render(<BlueprintsView />);

    expect(container.querySelector("header")).toHaveClass("app-shell__header");
    expect(
      container.querySelector(".blueprints-view__header"),
    ).not.toBeInTheDocument();
  });

  it("renders the brand and 'My Diagrams' as chrome links, not underlined body-text links (Bug 34)", () => {
    stubIdentity();

    render(<BlueprintsView />);

    expect(screen.getByRole("link", { name: "Architect" })).toHaveClass(
      "nav-link",
    );
    expect(screen.getByRole("link", { name: "My Diagrams" })).toHaveClass(
      "nav-link",
    );
  });

  it("carries exactly one dark-mode toggle, from the shared banner", () => {
    stubIdentity();

    render(<BlueprintsView />);

    expect(screen.getAllByTitle("Toggle dark mode")).toHaveLength(1);
  });

  it("offers sign-in and no identity error to an anonymous visitor", async () => {
    stubIdentity(
      new Response(JSON.stringify({ detail: "Unauthorized." }), {
        status: 401,
      }),
    );

    render(<BlueprintsView />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the identity and sign-out to a signed-in visitor", async () => {
    stubIdentity(identityResponse("member@example.com", false));

    render(<BlueprintsView />);

    await waitFor(() =>
      expect(screen.getByText("member@example.com")).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Sign out" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Admin" }),
    ).not.toBeInTheDocument();
  });

  it("offers the admin link to an administrator, alongside 'My Diagrams'", async () => {
    stubIdentity(identityResponse("admin@example.com", true));

    render(<BlueprintsView />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Admin" })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("link", { name: "My Diagrams" }),
    ).toBeInTheDocument();
  });

  it("requests the identity exactly once", () => {
    stubIdentity(identityResponse("member@example.com", false));

    render(<BlueprintsView />);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/me");
  });
});
