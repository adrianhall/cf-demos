import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingView } from "./LandingView";

describe("LandingView", () => {
  beforeEach(() => {
    // `AppHeader`'s `useIdentity()` call fetches `GET /api/me` on mount (GitLab issue #4 added
    // the shared banner to this page); stub it so every test renders against a stable,
    // never-resolving "still loading" identity rather than triggering an unhandled network
    // request or an act() warning from a real fetch resolving mid-test.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("links the hero call to action to the authenticated app shell", () => {
    render(<LandingView />);

    const ctas = screen.getAllByRole("link", { name: "Open the editor" });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      expect(cta).toHaveAttribute("href", "/app");
    }
  });

  it("styles the hero call to action as a button rather than an underlined text link (Bug 34)", () => {
    render(<LandingView />);

    const [cta] = screen.getAllByRole("link", { name: "Open the editor" });
    expect(cta).toHaveClass("button");
    expect(cta).toHaveClass("button--primary");
  });

  it("renders the primary call to action inside the hero section, above the fold", () => {
    const { container } = render(<LandingView />);

    const hero = container.querySelector(".landing__hero");
    expect(hero).not.toBeNull();
    expect(
      hero?.querySelector('a[href="/app"].button--primary'),
    ).not.toBeNull();
  });

  it("links to the public blueprint gallery as a secondary call to action", () => {
    render(<LandingView />);

    const links = screen.getAllByRole("link", { name: "Browse blueprints" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/blueprints");
    }
  });

  it("renders the shared banner (GitLab issue #4)", () => {
    const { container } = render(<LandingView />);

    expect(container.querySelector("header")).toHaveClass("app-shell__header");
    expect(screen.getByRole("link", { name: "Architect" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("renders a heading hierarchy describing the product beyond the hero", () => {
    render(<LandingView />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /Cloudflare architecture/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { level: 2 }).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("hides the decorative hero illustration from assistive technology", () => {
    const { container } = render(<LandingView />);

    const visual = container.querySelector(".landing__hero-visual");
    expect(visual).toHaveAttribute("aria-hidden", "true");
  });
});
