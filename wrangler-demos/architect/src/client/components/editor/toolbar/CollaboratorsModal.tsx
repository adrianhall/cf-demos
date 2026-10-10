import { useCallback, useEffect, useRef, useState } from "react";
import {
  addCollaborator,
  type Collaborator,
  listCollaborators,
  removeCollaborator,
} from "../../../api/collaborators";
import { useIdentity } from "../../../hooks/useIdentity";
import { useModalFocus } from "../../../hooks/useModalFocus";

/** The collaborator list's own loading/error/loaded phases, independent of the add-by-email
 * form's own busy/error state below. */
type ListState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; collaborators: Collaborator[] };

/**
 * Collaborator management modal, opened from the editor toolbar's "Manage collaborators" button
 * (`./Toolbar.tsx`) -- distinct from `./ShareModal.tsx`'s anonymous read-only link
 * (docs/09C-COLLABORATIVE-EDITING.md's Collaborator Model Client section): sharing a read-only
 * link and granting a specific person full edit access are two visibly different actions here,
 * matching them already being two different concepts server-side
 * (`../../../../worker/shares/repository.ts` vs. `../../../../worker/collaborators/repository.ts`).
 *
 * Lists every current collaborator. The diagram's owner (`useIdentity()`'s `email` compared
 * against `ownerEmail`, exactly like every other owner/editor distinction this phase's client
 * makes) sees a "Remove" control on every row and an add-by-email form; a collaborator sees a
 * "Leave" control on their own row only, and no add-by-email form -- both are owner-only
 * server-side (`POST`/`DELETE /api/diagrams/:id/collaborators`), so this mirrors that split
 * rather than introducing a new client-only permission model. Uses `useModalFocus()` for the
 * same modal accessibility behavior every other modal in this app already has.
 *
 * @param diagramId Diagram this modal manages collaborators for.
 * @param ownerEmail The diagram's owner email, or `null` in read-only mode (this modal is never
 * opened in that mode -- see `./Toolbar.tsx`).
 * @param open Whether the modal is visible.
 * @param onClose Called when the modal is dismissed.
 */
export function CollaboratorsModal({
  diagramId,
  ownerEmail,
  open,
  onClose,
}: {
  diagramId: string;
  ownerEmail: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const identity = useIdentity();
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [email, setEmail] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onClose);

  const isOwner = identity.email !== null && identity.email === ownerEmail;

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const collaborators = await listCollaborators(diagramId);
      setState({ collaborators, phase: "ready" });
    } catch (error) {
      setState({
        message:
          error instanceof Error
            ? error.message
            : "Could not load collaborators.",
        phase: "error",
      });
    }
  }, [diagramId]);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setAddError(null);
    void load();
  }, [open, load]);

  const handleAdd = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = email.trim();
      if (trimmed.length === 0) return;

      setAdding(true);
      setAddError(null);
      try {
        await addCollaborator(diagramId, trimmed);
        setEmail("");
        await load();
      } catch (error) {
        setAddError(
          error instanceof Error
            ? error.message
            : "Could not add collaborator.",
        );
      } finally {
        setAdding(false);
      }
    },
    [diagramId, email, load],
  );

  const handleRemove = useCallback(
    async (targetEmail: string) => {
      setBusyEmail(targetEmail);
      try {
        await removeCollaborator(diagramId, targetEmail);
        await load();
      } finally {
        setBusyEmail(null);
      }
    },
    [diagramId, load],
  );

  if (!open) return null;

  return (
    <div className="modal-overlay">
      {/* See `./ShareModal.tsx`'s identical backdrop comment: a real, keyboard-inert button
          gives click-outside-to-close for free, leaving Escape and the dialog's own Close/Done
          controls as the keyboard dismissal paths. */}
      <button
        type="button"
        className="modal-overlay__backdrop"
        aria-label="Close dialog"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaborators-modal-title"
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
        <h2 id="collaborators-modal-title" className="modal__title">
          Manage Collaborators
        </h2>

        {state.phase === "loading" && <p className="modal__text">Loading…</p>}

        {state.phase === "error" && (
          <p className="modal__text share-modal__error" role="alert">
            {state.message}
          </p>
        )}

        {state.phase === "ready" && (
          <>
            {state.collaborators.length === 0 ? (
              <p className="modal__text">No collaborators yet.</p>
            ) : (
              <ul className="collaborators-list">
                {state.collaborators.map((collaborator) => {
                  const isSelf = collaborator.email === identity.email;
                  const canRemove = isOwner || isSelf;
                  const busy = busyEmail === collaborator.email;
                  return (
                    <li
                      key={collaborator.email}
                      className="collaborators-list__item"
                    >
                      <span className="collaborators-list__email">
                        {collaborator.email}
                      </span>
                      {canRemove && (
                        <button
                          type="button"
                          className="button button--danger"
                          onClick={() => void handleRemove(collaborator.email)}
                          disabled={busy}
                        >
                          {busy ? "Removing…" : isOwner ? "Remove" : "Leave"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {isOwner && (
              <form onSubmit={(event) => void handleAdd(event)}>
                <div className="share-url-field">
                  <label
                    className="properties-panel__label"
                    htmlFor="collaborator-email"
                  >
                    Add collaborator by email
                  </label>
                  <div className="share-url-field__row">
                    <input
                      id="collaborator-email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="colleague@example.com"
                      className="share-url-field__input"
                      required
                    />
                    <button
                      type="submit"
                      className="button button--primary"
                      disabled={adding || email.trim().length === 0}
                    >
                      {adding ? "Adding…" : "Add"}
                    </button>
                  </div>
                  {addError && (
                    <p className="modal__text share-modal__error" role="alert">
                      {addError}
                    </p>
                  )}
                </div>
              </form>
            )}
          </>
        )}

        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
