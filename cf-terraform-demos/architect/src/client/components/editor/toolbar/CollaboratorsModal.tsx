import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Collaborator, DiagramRole } from '../../../api/diagrams.ts';
import { addCollaborator, listCollaborators, removeCollaborator } from '../../../api/diagrams.ts';
import { useModalFocus } from '../../../hooks/useModalFocus.ts';

/**
 * The list's phases.
 *
 * `loading` and `ready` are separate states rather than an empty list with a flag, for the reason
 * the share modal keeps its own phases apart: "nobody has been added yet" and "we have not asked
 * yet" look identical as an empty array and mean opposite things. Showing the first while the
 * second is true would tell an owner their collaborators had vanished.
 */
type CollaboratorsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; collaborators: Collaborator[] };

/**
 * Props for {@link CollaboratorControls}.
 */
interface CollaboratorControlsProps {
  /**
   * Diagram whose collaborators these controls manage.
   */
  diagramId: string;
  /**
   * The viewer's role on this diagram, which decides what the dialog offers: an owner manages
   * everybody, a collaborator may only leave.
   *
   * Named `viewerRole` rather than `role` because a JSX prop called `role` is read as the ARIA
   * attribute by both tooling and anybody skimming the call site — a real ambiguity for a component
   * that also sets `role="dialog"` on its own container.
   */
  viewerRole: DiagramRole;
  /**
   * The viewer's own verified email, used to find their own row so the Leave control sits on it.
   * `null` while the identity request is still in flight, in which case no Leave control is shown —
   * rather than guessing which row is the viewer's.
   */
  viewerEmail: string | null;
  /**
   * Called when the visitor dismisses the dialog.
   */
  onClose: () => void;
  /**
   * Called after the viewer removes their own access, so the editor can react to no longer having
   * any. Not called when an owner removes somebody else, because the owner's own access is
   * unchanged by that.
   */
  onLeft: () => void;
}

/**
 * The dialog's body: who currently has access, and whatever the viewer may do about it.
 *
 * Split out from {@link CollaboratorsModal} so the parent mounts it only while the dialog is open,
 * which is what resets the screen between openings through ordinary mount-time state rather than an
 * effect that writes state on every open. It matters here because the list is exactly the kind of
 * thing that changes while nobody is looking: the owner may have added somebody from another tab
 * since this one loaded the editor.
 *
 * @param props Diagram, viewer identity and the two callbacks; see
 *   {@link CollaboratorControlsProps}.
 * @returns The dialog body for the current state.
 */
function CollaboratorControls({
  diagramId,
  viewerRole,
  viewerEmail,
  onClose,
  onLeft
}: CollaboratorControlsProps) {
  const [state, setState] = useState<CollaboratorsState>({ phase: 'loading' });
  const [email, setEmail] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    listCollaborators(diagramId)
      .then((collaborators) => {
        if (!cancelled) {
          setState({ collaborators, phase: 'ready' });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            message: error instanceof Error ? error.message : 'Could not load collaborators.',
            phase: 'error'
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [diagramId]);

  /**
   * Adds the address in the form, and shows the server's own refusal if it has one.
   *
   * The server's `detail` is rendered verbatim rather than translated into a message of this
   * component's own. The two refusals a person can act on — "that address has never signed in" and
   * "that is your own address" — are written server-side precisely so they can be shown, and
   * restating them here would give the application two wordings of one rule that could drift.
   *
   * The list is reloaded rather than having the new grant appended locally, so a re-add of somebody
   * already present does not produce a duplicate row on screen for an operation the server treated
   * as a no-op.
   *
   * @param event Form submission, whose default navigation is prevented.
   * @returns A promise fulfilled once the list has been refreshed, or the refusal shown.
   */
  const handleAdd = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setAddError(null);
      try {
        await addCollaborator(diagramId, email.trim());
        setState({ collaborators: await listCollaborators(diagramId), phase: 'ready' });
        setEmail('');
      } catch (error) {
        setAddError(error instanceof Error ? error.message : 'Could not add that person.');
      } finally {
        // In a `finally` so a refusal leaves a usable form rather than a permanently disabled one
        // the visitor would have to reload to escape — which matters most here, where the
        // expected outcome of a refusal is to correct the address and try again.
        setBusy(false);
      }
    },
    [diagramId, email]
  );

  /**
   * Removes one grant, whether the owner is evicting somebody or the viewer is leaving.
   *
   * One handler for both, because it is one endpoint: the server decides which rule applies from
   * the verified identity, so the client does not need to know it. The `leaving` flag affects only
   * what happens afterwards — a viewer who has just removed their own access can no longer read
   * this diagram, so the dialog closes and tells the editor.
   *
   * @param target Address whose access is being removed.
   * @param leaving Whether `target` is the viewer's own address.
   * @returns A promise fulfilled once the list has been refreshed, or the failure shown.
   */
  const handleRemove = useCallback(
    async (target: string, leaving: boolean) => {
      setBusy(true);
      try {
        await removeCollaborator(diagramId, target);

        if (leaving) {
          onLeft();
          return;
        }
        setState({ collaborators: await listCollaborators(diagramId), phase: 'ready' });
      } catch (error) {
        setState({
          message: error instanceof Error ? error.message : 'Could not remove that person.',
          phase: 'error'
        });
      } finally {
        setBusy(false);
      }
    },
    [diagramId, onLeft]
  );

  if (state.phase === 'loading') {
    return <p className="modal__text">Loading…</p>;
  }

  if (state.phase === 'error') {
    return (
      <p className="modal__text share-modal__error" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <>
      <p className="modal__text">
        {viewerRole === 'owner'
          ? 'People you add here can edit this diagram. They need to have signed in to Architect '
            + 'at least once.'
          : 'These people can edit this diagram. Only its owner can add or remove anyone.'}
      </p>

      {state.collaborators.length === 0 ? (
        <p className="modal__text">Nobody else has access to this diagram yet.</p>
      ) : (
        <ul className="collaborators-list">
          {state.collaborators.map((collaborator) => {
            const isViewer = collaborator.collaboratorEmail === viewerEmail;
            // An owner may remove anybody; anybody else may remove only themselves. The same rule
            // the server enforces, mirrored here so a control is never offered that the server
            // would refuse — and re-derived there regardless, so this is presentation only.
            const removable = viewerRole === 'owner' || isViewer;

            return (
              <li className="collaborators-list__item" key={collaborator.collaboratorEmail}>
                <span className="collaborators-list__email">{collaborator.collaboratorEmail}</span>
                {removable && (
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() => void handleRemove(collaborator.collaboratorEmail, isViewer)}
                    disabled={busy}
                    // Named per row, so a screen reader hears whose access a button removes
                    // rather than a column of identical "Remove" controls.
                    aria-label={
                      isViewer ? 'Leave this diagram' : `Remove ${collaborator.collaboratorEmail}`
                    }
                  >
                    {isViewer ? 'Leave' : 'Remove'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {viewerRole === 'owner' && (
        <form onSubmit={(event) => void handleAdd(event)}>
          <div className="properties-panel__field">
            <label className="properties-panel__label" htmlFor="collaborator-email">
              Add by email
            </label>
            {/* `type="email"` for the keyboard it brings up on a phone and the browser's own
                cheap format check. It is not the real validation: the server's rule is that the
                address has already signed in here, which no input type can express. */}
            <input
              id="collaborator-email"
              type="email"
              className="properties-panel__input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="colleague@example.com"
            />
          </div>

          {/* `role="alert"` because the message replaces nothing on screen and appears in
              response to a submission, so a screen-reader user would otherwise have to go
              looking for it to find out why nothing happened. */}
          {addError && (
            <p className="create-diagram-modal__error" role="alert">
              {addError}
            </p>
          )}

          <div className="modal__actions">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={busy || email.trim().length === 0}
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      )}

      {viewerRole !== 'owner' && (
        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Props for {@link CollaboratorsModal}.
 */
export interface CollaboratorsModalProps {
  /**
   * Diagram whose collaborators this modal manages.
   */
  diagramId: string;
  /**
   * The viewer's role on this diagram, as the server reported it when the diagram was loaded.
   *
   * Named `viewerRole` rather than `role` so it is not mistaken for the ARIA attribute; see
   * {@link CollaboratorControlsProps}.
   */
  viewerRole: DiagramRole;
  /**
   * The viewer's own verified email, or `null` while it is still being resolved.
   */
  viewerEmail: string | null;
  /**
   * Whether the modal is visible.
   */
  open: boolean;
  /**
   * Called when the modal is dismissed. Shared by Done, the close control, the backdrop and Escape,
   * so there is one close path rather than four.
   */
  onClose: () => void;
  /**
   * Called after the viewer removes their own access to this diagram.
   */
  onLeft: () => void;
}

/**
 * Who may edit this diagram, opened from the editor toolbar.
 *
 * Deliberately a separate dialog from {@link ShareModal}, reached by a separate control, because
 * the two answer different questions and the server treats them as different things:
 *
 * - **Share** mints an anonymous, read-only link. Whoever holds it may look; nobody has to sign in,
 *   and nobody can change anything.
 * - **Collaborators** name specific, already-signed-in identities and let them edit.
 *
 * Collapsing them into one "Sharing" dialog with two tabs was the obvious alternative and is the
 * wrong one: it would invite the reading that a collaborator is a share link with a name on it, and
 * the single most important property of this screen is that adding somebody here gives them write
 * access to the document.
 *
 * This component owns the dialog shell and its focus; {@link CollaboratorControls} owns the state
 * inside it and is mounted only while the dialog is open, so each opening starts from the server's
 * current answer rather than from the last one.
 *
 * @param props Diagram, viewer identity, visibility and the two callbacks; see
 *   {@link CollaboratorsModalProps}.
 * @returns The modal, or `null` while closed.
 */
export function CollaboratorsModal({
  diagramId,
  viewerRole,
  viewerEmail,
  open,
  onClose,
  onLeft
}: CollaboratorsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onClose);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay">
      {/* A real, natively keyboard-operable button behind the dialog rather than a click handler
          on a non-interactive div, matching `./ShareModal.tsx`. `tabIndex={-1}` keeps it out of
          the tab order — see `../../../hooks/useModalFocus.ts`. */}
      <button
        type="button"
        className="modal-overlay__backdrop"
        aria-label="Close dialog"
        onClick={onClose}
        tabIndex={-1}
      />
      {/* A `div` with `role="dialog"` rather than a native `<dialog>`, for the reason recorded in
          `../../blueprints/CreateDiagramModal.tsx`: `showModal()` and this application's shared
          focus hook do not compose. */}
      <div
        ref={dialogRef}
        className="modal"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaborators-modal-title"
        tabIndex={-1}
      >
        <button className="modal__close" onClick={onClose} aria-label="Close" type="button">
          &times;
        </button>
        <h2 id="collaborators-modal-title" className="modal__title">
          Collaborators
        </h2>
        <CollaboratorControls
          diagramId={diagramId}
          viewerRole={viewerRole}
          viewerEmail={viewerEmail}
          onClose={onClose}
          onLeft={onLeft}
        />
      </div>
    </div>
  );
}
