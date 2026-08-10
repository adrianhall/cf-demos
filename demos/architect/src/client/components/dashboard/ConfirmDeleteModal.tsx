import { useRef } from "react";
import { useModalFocus } from "../../hooks/useModalFocus";

/**
 * Confirmation modal shown before deleting a diagram. Ported from CF-Architect's
 * `src/islands/dashboard/ConfirmDeleteModal.tsx`, plus this port's `useModalFocus()` addition
 * (Bug 13, docs/09-ARCHITECT.md Phase 7) for initial focus, Tab-trapping, `Escape`-to-close, and
 * focus restoration on close.
 *
 * @param open Whether the modal is visible.
 * @param diagramTitle Title of the diagram about to be deleted, shown in the confirmation copy.
 * @param onConfirm Called when the user confirms the deletion.
 * @param onCancel Called when the user dismisses the modal without deleting.
 */
export function ConfirmDeleteModal({
  open,
  diagramTitle,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  diagramTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onCancel);

  if (!open) return null;

  return (
    <div className="modal-overlay">
      {/* A real, natively keyboard-operable button behind the dialog, rather than a click
          handler on a non-interactive `<div>` -- gives click-outside-to-close for free with no
          `useKeyWithClickEvents` suppression needed. `tabIndex={-1}` keeps it out of the Tab
          order entirely -- see `useModalFocus.ts`'s JSDoc for why -- leaving Escape and the
          dialog's own Cancel/Close controls as the keyboard dismissal paths. */}
      <button
        type="button"
        className="modal-overlay__backdrop"
        aria-label="Close dialog"
        onClick={onCancel}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        tabIndex={-1}
      >
        <button
          className="modal__close"
          onClick={onCancel}
          aria-label="Close"
          type="button"
        >
          &times;
        </button>
        <h2 id="confirm-delete-title" className="modal__title">
          Delete Diagram
        </h2>
        <p className="modal__text">
          Are you sure you want to delete &ldquo;{diagramTitle}&rdquo;? This
          action cannot be undone.
        </p>
        <div className="modal__actions">
          <button className="button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="button button--danger"
            onClick={onConfirm}
            type="button"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
