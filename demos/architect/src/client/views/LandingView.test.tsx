import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LandingView } from "./LandingView";

describe("LandingView", () => {
  it("links to the authenticated app shell", () => {
    render(<LandingView />);

    expect(
      screen.getByRole("link", { name: "Open the editor" }),
    ).toHaveAttribute("href", "/app");
  });

  it("styles the call to action as a button rather than an underlined text link (Bug 34)", () => {
    render(<LandingView />);

    const cta = screen.getByRole("link", { name: "Open the editor" });
    expect(cta).toHaveClass("button");
    expect(cta).toHaveClass("button--primary");
  });
});
