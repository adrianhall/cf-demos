import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./useModalFocus";

describe("useModalFocus", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function buildDialog(): {
    dialog: HTMLDivElement;
    trigger: HTMLButtonElement;
  } {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();

    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    document.body.appendChild(dialog);
    return { dialog, trigger };
  }

  it("moves focus to the first focusable descendant on open", () => {
    const { dialog } = buildDialog();
    const first = document.createElement("button");
    first.textContent = "First";
    const second = document.createElement("button");
    second.textContent = "Second";
    dialog.appendChild(first);
    dialog.appendChild(second);

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(true, ref, vi.fn()));

    expect(document.activeElement).toBe(first);
  });

  it("focuses the dialog itself when it has no focusable descendant", () => {
    const { dialog } = buildDialog();
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(true, ref, vi.fn()));

    expect(document.activeElement).toBe(dialog);
  });

  it("keeps focus on the dialog when Tab is pressed with no focusable descendant", () => {
    const { dialog } = buildDialog();
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(true, ref, vi.fn()));

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  it("tolerates a null dialogRef -- no initial focus move, no Tab trap", () => {
    const { trigger } = buildDialog();
    const ref = createRef<HTMLElement>();
    renderHook(() => useModalFocus(true, ref, vi.fn()));

    // No focusable element to move to, and no dialog to focus as a fallback -- focus simply
    // stays wherever it already was.
    expect(document.activeElement).toBe(trigger);

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores a key other than Tab or Escape", () => {
    const { dialog } = buildDialog();
    const first = document.createElement("button");
    dialog.appendChild(first);
    first.focus();

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    const onClose = vi.fn();
    renderHook(() => useModalFocus(true, ref, onClose));

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "a",
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
  });

  it("leaves focus untouched on Tab from a middle element within the dialog", () => {
    const { dialog } = buildDialog();
    const first = document.createElement("button");
    const middle = document.createElement("button");
    const last = document.createElement("button");
    dialog.appendChild(first);
    dialog.appendChild(middle);
    dialog.appendChild(last);

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(true, ref, vi.fn()));
    middle.focus();

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(middle);
  });

  it("leaves focus untouched on Shift+Tab from a middle element within the dialog", () => {
    const { dialog } = buildDialog();
    const first = document.createElement("button");
    const middle = document.createElement("button");
    const last = document.createElement("button");
    dialog.appendChild(first);
    dialog.appendChild(middle);
    dialog.appendChild(last);

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(true, ref, vi.fn()));
    middle.focus();

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
      shiftKey: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(middle);
  });

  it("pulls focus back into the dialog on Shift+Tab if it somehow escapes", () => {
    const { dialog } = buildDialog();
    const first = document.createElement("button");
    const last = document.createElement("button");
    dialog.appendChild(first);
    dialog.appendChild(last);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(true, ref, vi.fn()));
    outside.focus();

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
        shiftKey: true,
      }),
    );

    expect(document.activeElement).toBe(last);
  });

  it("does nothing while closed", () => {
    const { dialog, trigger } = buildDialog();
    const first = document.createElement("button");
    dialog.appendChild(first);

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(false, ref, vi.fn()));

    expect(document.activeElement).toBe(trigger);
  });

  it("wraps Tab from the last element to the first", () => {
    const { dialog } = buildDialog();
    const first = document.createElement("button");
    const last = document.createElement("button");
    dialog.appendChild(first);
    dialog.appendChild(last);
    last.focus();

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(true, ref, vi.fn()));
    last.focus();

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
      }),
    );

    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    const { dialog } = buildDialog();
    const first = document.createElement("button");
    const last = document.createElement("button");
    dialog.appendChild(first);
    dialog.appendChild(last);

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(true, ref, vi.fn()));
    first.focus();

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
        shiftKey: true,
      }),
    );

    expect(document.activeElement).toBe(last);
  });

  it("pulls focus back into the dialog if it somehow escapes", () => {
    const { dialog } = buildDialog();
    const first = document.createElement("button");
    const last = document.createElement("button");
    dialog.appendChild(first);
    dialog.appendChild(last);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    renderHook(() => useModalFocus(true, ref, vi.fn()));
    outside.focus();

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
      }),
    );

    expect(document.activeElement).toBe(first);
  });

  it("calls onClose on Escape", () => {
    const { dialog } = buildDialog();
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    const onClose = vi.fn();
    renderHook(() => useModalFocus(true, ref, onClose));

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the trigger when the dialog closes", () => {
    const { dialog, trigger } = buildDialog();
    const first = document.createElement("button");
    dialog.appendChild(first);

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = dialog;
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useModalFocus(open, ref, vi.fn()),
      { initialProps: { open: true } },
    );
    expect(document.activeElement).toBe(first);

    rerender({ open: false });

    expect(document.activeElement).toBe(trigger);
  });
});
