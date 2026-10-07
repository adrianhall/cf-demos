import { useRef } from 'react';
import { useModalFocus } from '../../hooks/useModalFocus.ts';

/**
 * Props for {@link ConfirmDeleteModal}.
 */
export interface ConfirmDeleteModalProps {
  /**
   * Whether the modal is visible.
   */
  open: boolean;
  /**
   * Title of the diagram about to be deleted, shown in the confirmation copy so the visitor can see
   * which one they are about to lose.
   */
  diagramTitle: string;
  /**
   * Called when the visitor confirms the deletion.
   */
  onConfirm: () => void;
  /**
   * Called when the visitor dismisses the modal without deleting. Shared by Cancel, the close
   * control, the backdrop and Escape.
   */
  onCancel: () => void;
}

/**
 * Confirmation shown before a diagram is deleted.
 *
 * `role="alertdialog"` rather than `role="dialog"`: the distinction tells assistive technology this
 * dialog carries a message that needs a response, so its text is announced on open rather than only
 * its accessible name. Deletion is unrecoverable here — there is no trash and no undo — so the
 * message naming the diagram is the point of the dialog.
 *
 * @param props Visibility, the diagram's title and the two outcomes; see
 *   {@link ConfirmDeleteModalProps}.
 * @returns The modal, or `null` while closed.
 */
export function ConfirmDeleteModal({
  open,
  diagramTitle,
  onConfirm,
  onCancel
}: ConfirmDeleteModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onCancel);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay">
      {/* See `../blueprints/CreateDiagramModal.tsx` for why this is a real button held out of the
          tab order rather than a click handler on a div. */}
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
        <button className="modal__close" onClick={onCancel} aria-label="Close" type="button">
          &times;
        </button>
        <h2 id="confirm-delete-title" className="modal__title">
          Delete Diagram
        </h2>
        <p className="modal__text">
          Are you sure you want to delete &ldquo;{diagramTitle}&rdquo;? This action cannot be
          undone.
        </p>
        <div className="modal__actions">
          <button className="button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="button button--danger" onClick={onConfirm} type="button">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
