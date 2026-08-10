import { useCallback, useRef, useState } from "react";
import type { Blueprint } from "../../../blueprints";
import { createDiagram } from "../../api/diagrams";
import { useModalFocus } from "../../hooks/useModalFocus";
import { BlueprintPreview } from "./BlueprintPreview";

/**
 * Form body for {@link CreateDiagramModal}, re-mounted (via the parent's `key`) whenever the
 * selected blueprint changes so its title/description fields reset cleanly without a
 * render-time `setState` inside an effect.
 */
function CreateForm({
  blueprint,
  onClose,
}: {
  blueprint: Blueprint | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(blueprint?.title ?? "Untitled Diagram");
  const [description, setDescription] = useState(blueprint?.description ?? "");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const diagram = await createDiagram({
        blueprintId: blueprint?.id,
        description: description || undefined,
        title,
      });
      window.location.href = `/app/diagram/${diagram.id}`;
    } catch (cause) {
      setCreating(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create the diagram.",
      );
    }
  }, [title, description, blueprint]);

  return (
    <>
      <h2 className="modal__title">
        {blueprint ? blueprint.title : "Create New Diagram"}
      </h2>

      {blueprint && (
        <span className="blueprint-card__badge">{blueprint.category}</span>
      )}

      <div className="create-diagram-modal__layout">
        <div className="create-diagram-modal__preview">
          {blueprint ? (
            <BlueprintPreview graphData={blueprint.graphData} height={320} />
          ) : (
            <div className="create-diagram-modal__blank-preview">
              <span>Start with a blank canvas</span>
            </div>
          )}
        </div>

        <div className="create-diagram-modal__form">
          <label className="properties-panel__label" htmlFor="diagram-title">
            Title
          </label>
          <input
            id="diagram-title"
            className="properties-panel__input"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={255}
          />

          <label
            className="properties-panel__label"
            htmlFor="diagram-description"
            style={{ marginTop: 12 }}
          >
            Description
          </label>
          <textarea
            id="diagram-description"
            className="properties-panel__input properties-panel__textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2_000}
            rows={3}
          />

          {error && (
            <p className="create-diagram-modal__error" role="alert">
              {error}
            </p>
          )}

          <div className="create-diagram-modal__actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void handleCreate()}
              disabled={creating || title.trim().length === 0}
            >
              {creating ? "Creating…" : "Create Diagram"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Modal for creating a new diagram, either blank or seeded from a blueprint template. Ported
 * from CF-Architect's `src/islands/blueprints/CreateDiagramModal.tsx`, plus this port's
 * `useModalFocus()` addition (Bug 13, docs/09-ARCHITECT.md Phase 7) for initial focus,
 * Tab-trapping, `Escape`-to-close, and focus restoration on close. Navigates to the new
 * diagram's editor on success via a full page load (`window.location.href`), matching every
 * other `/app*` boundary crossing in this SPA (`../../App.tsx`'s JSDoc).
 *
 * @param open Whether the modal is visible.
 * @param onClose Called when the modal is dismissed without creating a diagram.
 * @param blueprint The selected blueprint template, or `null` for a blank canvas.
 */
export function CreateDiagramModal({
  open,
  onClose,
  blueprint,
}: {
  open: boolean;
  onClose: () => void;
  blueprint: Blueprint | null;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onClose);

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
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="modal modal--large"
        role="dialog"
        aria-modal="true"
        aria-label={blueprint ? blueprint.title : "Create New Diagram"}
        tabIndex={-1}
      >
        <button
          className="modal__close"
          onClick={onClose}
          aria-label="Close"
          type="button"
        >
          &times;
        </button>
        <CreateForm
          key={blueprint?.id ?? "__blank__"}
          blueprint={blueprint}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
