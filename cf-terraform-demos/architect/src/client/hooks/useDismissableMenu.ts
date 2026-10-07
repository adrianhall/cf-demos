import { type RefObject, useEffect } from 'react';

/**
 * Closes an open popup menu on an outside pointer press or on Escape.
 *
 * Both paths matter, and the keyboard one is the reason this is a hook rather than an inline
 * effect. A menu that closes only on an outside click leaves a keyboard-only user with no way to
 * dismiss it at all: they can tab away, but the menu stays visibly open over the content they moved
 * to. Every menu in this application therefore shares one implementation of both.
 *
 * `mousedown` rather than `click`, because a menu item's own `click` handler should run before the
 * menu closes — closing on `click` can unmount the item between press and release and lose the
 * activation entirely.
 *
 * @param open Whether the menu is currently open. The hook is a no-op while `false`.
 * @param containerRef Ref to the menu's outermost container, covering both its trigger button and
 *   its popup, so a press anywhere inside it does not dismiss it.
 * @param onDismiss Called once, on an outside press or on Escape. The caller owns the open state.
 * @returns Nothing. The document listeners are the effect.
 */
export function useDismissableMenu(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void
): void {
  useEffect(() => {
    // `undefined` rather than a bare `return`, so every path through this effect agrees on
    // returning a cleanup-or-nothing value instead of leaving one branch implicit.
    if (!open) {
      return undefined;
    }

    /**
     * Dismisses the menu when the press landed outside its container.
     *
     * @param event Pointer event from the document-level listener.
     * @returns Nothing.
     */
    const handleOutsidePress = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onDismiss();
      }
    };

    /**
     * Dismisses the menu on Escape.
     *
     * @param event Keyboard event from the document-level listener.
     * @returns Nothing.
     */
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onDismiss();
      }
    };

    document.addEventListener('mousedown', handleOutsidePress);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsidePress);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, containerRef, onDismiss]);
}
