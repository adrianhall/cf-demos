/**
 * Confirmation modal shown before deleting a diagram. Ported from CF-Architect's
 * `src/islands/dashboard/ConfirmDeleteModal.tsx`.
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
  if (!open) return null;

  return (
    <div className="modal-overlay">
      {/* A real, natively keyboard-operable button behind the dialog, rather than a click
          handler on a non-interactive `<div>` -- gives click-outside-to-close for free with no
          `useKeyWithClickEvents` suppression needed. */}
      <button
        type="button"
        className="modal-overlay__backdrop"
        aria-label="Close dialog"
        onClick={onCancel}
      />
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
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
