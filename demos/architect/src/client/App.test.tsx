import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("renders the public landing page at /", () => {
    window.history.pushState({}, "", "/");

    render(<App />);

    // GitLab issue #4's redesigned landing page repeats the primary call to action in both the
    // hero and the closing CTA banner, so there are two matches here rather than one.
    expect(
      screen.getAllByRole("link", { name: "Open the editor" }),
    ).not.toHaveLength(0);
  });

  it("renders the authenticated app shell under /app", () => {
    window.history.pushState({}, "", "/app");

    render(<App />);

    expect(screen.getByText("Architect")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign out" })).toBeInTheDocument();
  });

  it("renders the authenticated app shell under a nested /app path", () => {
    window.history.pushState({}, "", "/app/diagrams/example");

    render(<App />);

    expect(screen.getByRole("link", { name: "Sign out" })).toBeInTheDocument();
  });

  it("renders the public blueprint gallery at /blueprints", () => {
    window.history.pushState({}, "", "/blueprints");

    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Start a new diagram" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Blank Canvas/ }),
    ).toBeInTheDocument();
    expect(screen.getByTitle("Toggle dark mode")).toBeInTheDocument();
  });

  it("renders the shared banner on the public blueprint gallery (Bug 34)", () => {
    window.history.pushState({}, "", "/blueprints");

    const { container } = render(<App />);

    expect(container.querySelector("header")).toHaveClass("app-shell__header");
    expect(screen.getByRole("link", { name: "Architect" })).toHaveClass(
      "nav-link",
    );
    expect(screen.getByRole("link", { name: "My Diagrams" })).toHaveAttribute(
      "href",
      "/app",
    );
  });

  it("renders the public read-only share viewer at /s/:token", () => {
    window.history.pushState({}, "", "/s/abc123");

    render(<App />);

    expect(screen.getByText("Loading shared diagram…")).toBeInTheDocument();
  });

  it("renders the share viewer for a token with URL-encoded characters", () => {
    window.history.pushState({}, "", "/s/abc%20123");

    render(<App />);

    expect(screen.getByText("Loading shared diagram…")).toBeInTheDocument();
  });
});
