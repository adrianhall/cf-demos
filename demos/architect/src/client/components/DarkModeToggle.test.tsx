import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DarkModeToggle } from "./DarkModeToggle";

describe("DarkModeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("labels itself 'Dark mode' when the OS prefers light with no stored preference", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      }),
    );

    render(<DarkModeToggle />);

    expect(screen.getByRole("button", { name: "Dark mode" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("labels itself 'Light mode' when the OS prefers dark with no stored preference", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
      }),
    );

    render(<DarkModeToggle />);

    expect(screen.getByRole("button", { name: "Light mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("respects an already-stored explicit preference over the OS preference", () => {
    localStorage.setItem("theme", "dark");
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      }),
    );

    render(<DarkModeToggle />);

    expect(
      screen.getByRole("button", { name: "Light mode" }),
    ).toBeInTheDocument();
  });

  it("toggles the color scheme, persists the choice, and flips its own label", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      }),
    );

    render(<DarkModeToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Dark mode" }));

    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(
      screen.getByRole("button", { name: "Light mode" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Light mode" }));

    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
    expect(
      screen.getByRole("button", { name: "Dark mode" }),
    ).toBeInTheDocument();
  });

  it("applies a custom className to the underlying button", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      }),
    );

    render(<DarkModeToggle className="toolbar__button" />);

    expect(screen.getByRole("button")).toHaveClass("toolbar__button");
  });

  it("defaults to the generic 'button' class with no className prop", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      }),
    );

    render(<DarkModeToggle />);

    expect(screen.getByRole("button")).toHaveClass("button");
  });

  it("tracks a live OS preference change while no explicit preference is stored", () => {
    let changeHandler: (() => void) | undefined;
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn((_event: string, handler: () => void) => {
          changeHandler = handler;
        }),
        matches: false,
        removeEventListener: vi.fn(),
      }),
    );

    render(<DarkModeToggle />);
    expect(
      screen.getByRole("button", { name: "Dark mode" }),
    ).toBeInTheDocument();

    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    act(() => changeHandler?.());

    expect(
      screen.getByRole("button", { name: "Light mode" }),
    ).toBeInTheDocument();
  });

  it("ignores OS preference changes once an explicit preference has been stored", () => {
    const addEventListener = vi.fn();
    localStorage.setItem("theme", "light");
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener,
        matches: true,
        removeEventListener: vi.fn(),
      }),
    );

    render(<DarkModeToggle />);

    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("removes its media query listener on unmount", () => {
    const removeEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener,
      }),
    );

    const { unmount } = render(<DarkModeToggle />);
    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });
});
