import { useCallback, useRef, useState } from 'react';
import type { Blueprint } from '../../../blueprints.ts';
import { createDiagram } from '../../api/diagrams.ts';
import { useModalFocus } from '../../hooks/useModalFocus.ts';
import { BlueprintPreview } from './BlueprintPreview.tsx';

/**
 * Title used when a visitor starts from a blank canvas.
 *
 * Matches the server's own default, so the field shows the name the diagram would get anyway rather
 * than an empty box the visitor has to guess the consequence of leaving alone.
 */
const BLANK_TITLE = 'Untitled Diagram';

/**
 * Accessible name and heading for the modal when no blueprint is selected.
 */
const BLANK_HEADING = 'Create New Diagram';

/**
 * Props for {@link CreateForm}.
 */
interface CreateFormProps {
  /**
   * Selected blueprint, or `null` for a blank canvas.
   */
  blueprint: Blueprint | null;
  /**
   * Called when the visitor dismisses the form without creating anything.
   */
  onClose: () => void;
}

/**
 * The modal's body: the selected graph on the left, the title and description on the right.
 *
 * Split out from {@link CreateDiagramModal} so the parent can re-mount it with a `key` whenever the
 * selected blueprint changes. That resets the two fields to the new template's values through
 * ordinary mount-time state, instead of an effect that writes state during render — which would
 * also discard an edit the visitor had already made to the previous selection.
 *
 * @param props Selected blueprint and close handler; see {@link CreateFormProps}.
 * @returns The modal body.
 */
function CreateForm({ blueprint, onClose }: CreateFormProps) {
  const [title, setTitle] = useState(blueprint?.title ?? BLANK_TITLE);
  const [description, setDescription] = useState(blueprint?.description ?? '');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const diagram = await createDiagram({
        blueprintId: blueprint?.id,
        description: description || undefined,
        title
      });
      // A full document navigation, not a history push. `/app/*` requires a verified Access
      // identity, and only a real document request lets Access intercept it before the bundle for
      // that page runs — see `../../App.tsx`.
      window.location.href = `/app/diagram/${diagram.id}`;
    } catch (cause) {
      // Re-enabled rather than left disabled: a failure here is usually recoverable — an expired
      // Access session, a title the server rejected — and a dead button would force the visitor to
      // reload and lose what they typed.
      setCreating(false);
      setError(cause instanceof Error ? cause.message : 'Could not create the diagram.');
    }
  }, [title, description, blueprint]);

  return (
    <>
      <h2 className="modal__title">{blueprint ? blueprint.title : BLANK_HEADING}</h2>

      {blueprint && <span className="blueprint-card__badge">{blueprint.category}</span>}

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
              {creating ? 'Creating…' : 'Create Diagram'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Props for {@link CreateDiagramModal}.
 */
export interface CreateDiagramModalProps {
  /**
   * Whether the modal is visible.
   */
  open: boolean;
  /**
   * Called when the modal is dismissed without creating a diagram. Shared by Cancel, the close
   * control, the backdrop and Escape, so there is one close path rather than four.
   */
  onClose: () => void;
  /**
   * Selected blueprint template, or `null` for a blank canvas.
   */
  blueprint: Blueprint | null;
}

/**
 * The single creation experience, opened over the blueprint gallery.
 *
 * Creation happens here rather than on a separate page, which is why the dashboard's create control
 * links to `/blueprints`: naming a diagram is a decision a visitor makes _about_ a starting point,
 * so the starting point stays on screen — its real graph in the left column — while they do it. A
 * standalone form would ask the same questions with the answer removed from view.
 *
 * @param props Visibility, close handler and selected blueprint; see
 *   {@link CreateDiagramModalProps}.
 * @returns The modal, or `null` while closed.
 */
export function CreateDiagramModal({ open, onClose, blueprint }: CreateDiagramModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onClose);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay">
      {/* A real, natively keyboard-operable button behind the dialog rather than a click handler
          on a non-interactive div, which gives click-outside-to-close with no suppressed lint rule.
          `tabIndex={-1}` keeps it out of the tab order entirely — see `useModalFocus.ts` — leaving
          Escape and the dialog's own visible controls as the keyboard dismissal paths. */}
      <button
        type="button"
        className="modal-overlay__backdrop"
        aria-label="Close dialog"
        onClick={onClose}
        tabIndex={-1}
      />
      {/* A `div` with `role="dialog"` rather than a native `<dialog>`, which the lint rule would
          otherwise prefer. `<dialog open>` is not the same thing as `showModal()`: only the latter
          creates the top layer, the backdrop and the focus containment, and it has to be called
          imperatively against the element. Every modal in this application already shares one
          focus implementation through `useModalFocus`, and the two mechanisms do not compose —
          mixing them would mean two sources of truth for what is focused. This is deliberate and
          tested; see the focus-management cases in `tests/client/CreateDiagramModal.test.tsx`. */}
      <div
        ref={dialogRef}
        className="modal modal--large"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="dialog"
        aria-modal="true"
        aria-label={blueprint ? blueprint.title : BLANK_HEADING}
        tabIndex={-1}
      >
        <button className="modal__close" onClick={onClose} aria-label="Close" type="button">
          &times;
        </button>
        {/* Re-mounted whenever the selection changes, which is what resets the fields. */}
        <CreateForm key={blueprint?.id ?? '__blank__'} blueprint={blueprint} onClose={onClose} />
      </div>
    </div>
  );
}
