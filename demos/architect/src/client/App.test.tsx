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

    expect(
      screen.getByRole("link", { name: "Open the editor" }),
    ).toBeInTheDocument();
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
  });
});
