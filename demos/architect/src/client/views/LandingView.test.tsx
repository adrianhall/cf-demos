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
});
