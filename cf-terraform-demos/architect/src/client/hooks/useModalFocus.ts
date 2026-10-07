import { type RefObject, useEffect, useRef } from 'react';

/**
 * Selector matching every element a modal's Tab trap should cycle through.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/**
 * Collects a dialog's focusable descendants in DOM — and therefore tab — order.
 *
 * @param dialog Dialog element to search.
 * @returns Every focusable descendant, in tab order.
 */
function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Manages a modal dialog's focus: moves focus in on open, traps Tab and Shift+Tab inside it, closes
 * on Escape, and restores focus to whatever opened it.
 *
 * Every modal in this application sets `aria-modal="true"`, which promises assistive technology
 * that the rest of the page is unreachable. Without this hook, Tab would walk a keyboard user
 * straight out of the dialog into the page behind it — the markup would be making a claim the
 * behaviour contradicts, which is worse than not making it.
 *
 * The trap's boundary is the dialog element itself, not the surrounding overlay, and that is
 * deliberate. Each modal's backdrop-dismiss control is a real `<button>` positioned _before_ the
 * dialog in the DOM, so trapping within the overlay would let Shift+Tab from the dialog's first
 * control land on the backdrop and make it a genuine tab stop with no visible affordance. Instead
 * every modal gives that button `tabIndex={-1}`: it stays a valid pointer dismissal target, while
 * Escape and the dialog's own visible Cancel and Close controls are the keyboard paths.
 *
 * `inert` on the application root is not used. These modals render inline in the React tree rather
 * than through a portal, so inerting the root would inert the dialog along with everything else.
 *
 * @param open Whether the modal is currently open. The hook is a no-op while `false`.
 * @param dialogRef Ref to the dialog's root element — the `role="dialog"` or `role="alertdialog"`
 *   node. Give it `tabIndex={-1}` so focus has somewhere to land when the dialog has no focusable
 *   descendant.
 * @param onClose Called when Escape is pressed while the dialog is open.
 * @returns Nothing. Focus movement and the key listener are the effect.
 */
export function useModalFocus(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void
): void {
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // `undefined` rather than a bare `return`, so every path through this effect agrees on
    // returning a cleanup-or-nothing value instead of leaving one branch implicit.
    if (!open) {
      return undefined;
    }

    // Captured on open rather than on close: by the time the dialog closes, the element that
    // opened it is no longer the active element, so there would be nothing left to return to.
    triggerRef.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    const initial = dialog ? focusableElements(dialog)[0] : undefined;
    (initial ?? dialog)?.focus();

    /**
     * Handles Escape and the Tab trap.
     *
     * The focusable set is recomputed on every keystroke rather than captured once, because a
     * dialog's controls change as the user types — a disabled Create button becomes focusable the
     * moment the title field is non-empty, and a trap built on a stale list would skip it.
     *
     * @param event Keyboard event from the document-level listener.
     * @returns Nothing.
     */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !dialog) {
        return;
      }

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

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      triggerRef.current?.focus();
    };
  }, [open, dialogRef, onClose]);
}
