import { type RefObject, useEffect, useRef } from "react";

/** CSS selector matching every element a modal's Tab trap should cycle through. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Every focusable descendant of `dialog`, in DOM (tab) order. */
function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Modal focus management: move focus into the dialog when it opens, trap Tab/Shift+Tab within
 * it, close on `Escape`, and restore focus to whatever triggered the dialog when it closes.
 * Fixes Bug 13 (docs/09-ARCHITECT.md Phase 7) -- `ShareModal`, `CreateDiagramModal`, and
 * `ConfirmDeleteModal` all set `aria-modal="true"` but previously did none of this, so Tab could
 * walk a keyboard user out of the dialog into the page behind it, contradicting `aria-modal`.
 *
 * The trap's boundary is the dialog element itself (`dialogRef`), not the surrounding
 * `.modal-overlay`: each modal's backdrop-dismiss `<button>` is a DOM sibling positioned
 * *before* the dialog, so trapping within the overlay would let Shift+Tab from the dialog's
 * first control land on it and make it a real tab stop. Instead, every modal gives that button
 * `tabIndex={-1}` -- it stays a valid pointer/touch dismissal target (and an accessible-name-only
 * target for `aria-label`), while `Escape` (handled here) and the dialog's own visible
 * Cancel/Close controls remain the keyboard ways to dismiss it.
 *
 * @param open Whether the modal is currently open. The hook is a no-op while `false`.
 * @param dialogRef Ref to the dialog's root element (the `role="dialog"`/`"alertdialog"` node).
 * Give it `tabIndex={-1}` so focus has somewhere to land if the dialog has no focusable
 * descendant.
 * @param onClose Called once when `Escape` is pressed while the dialog is open.
 */
export function useModalFocus(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    triggerRef.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    const initial = dialog ? focusableElements(dialog)[0] : undefined;
    (initial ?? dialog)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialog) return;

      const elements = focusableElements(dialog);
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = elements[0] as HTMLElement;
      const last = elements[elements.length - 1] as HTMLElement;
      const active = document.activeElement;
      const withinDialog = active instanceof Node && dialog.contains(active);

      if (event.shiftKey) {
        if (!withinDialog || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!withinDialog || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      triggerRef.current?.focus();
    };
  }, [open, dialogRef, onClose]);
}
