import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDismissableMenu } from "./useDismissableMenu";

describe("useDismissableMenu", () => {
  it("does nothing while closed", () => {
    const container = document.createElement("div");
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = container;
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(false, ref, onDismiss));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("calls onDismiss on an outside mousedown", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = container;
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(true, ref, onDismiss));
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not call onDismiss on a click inside the container", () => {
    const container = document.createElement("div");
    const inner = document.createElement("button");
    container.appendChild(inner);
    document.body.appendChild(container);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = container;
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(true, ref, onDismiss));
    inner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("calls onDismiss on Escape", () => {
    const container = document.createElement("div");
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = container;
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(true, ref, onDismiss));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stops listening after unmount", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = container;
    const onDismiss = vi.fn();

    const { unmount } = renderHook(() =>
      useDismissableMenu(true, ref, onDismiss),
    );
    unmount();
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
