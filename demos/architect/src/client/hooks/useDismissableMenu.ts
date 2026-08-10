import { type RefObject, useEffect } from "react";

/**
 * Close an open popup menu on an outside pointer click or on `Escape`, matching
 * `DiagramGrid.tsx`'s `CardMenu` -- the one of this app's three menus (the others being
 * `ExportButton.tsx` and `Toolbar.tsx`'s layout-direction menu) that already handled both before
 * this hook existed. `ExportButton` and the layout-direction menu previously closed only on
 * outside `mousedown`, leaving a keyboard-only user with no way to dismiss either without tabbing
 * away while the menu stayed visually open (WCAG 2.1.2-adjacent dismissal expectation).
 *
 * @param open Whether the menu is currently open. The hook is a no-op while `false`.
 * @param containerRef Ref to the menu's outermost container (button + popup); a click anywhere
 * inside it does not close the menu.
 * @param onDismiss Called once, either on an outside `mousedown` or on `Escape`, to close the
 * menu. The caller owns the actual `open` state.
 */
export function useDismissableMenu(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        onDismiss();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, containerRef, onDismiss]);
}
