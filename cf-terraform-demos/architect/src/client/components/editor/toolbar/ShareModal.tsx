import { useCallback, useEffect, useRef, useState } from 'react';
import { createShare, getShareStatus, revokeShare } from '../../../api/shares.ts';
import { useModalFocus } from '../../../hooks/useModalFocus.ts';

/**
 * The modal's phases.
 *
 * `active` and `revealed` look like they could be one state with an optional URL, and deliberately
 * are not. A link is `revealed` only in the session that minted it, because the server keeps no
 * copy: reopening the modal on the next page load gives `active` — a link exists, and this screen
 * cannot show it. Collapsing the two would invite a component to "just re-fetch the URL", which is
 * precisely the thing that cannot be done.
 */
type ShareModalState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'inactive' }
  | { phase: 'active' }
  | { phase: 'revealed'; url: string };

/**
 * Props for {@link ShareControls}.
 */
interface ShareControlsProps {
  /**
   * Diagram whose sharing these controls manage.
   */
  diagramId: string;
  /**
   * Called when the visitor dismisses the dialog.
   */
  onClose: () => void;
}

/**
 * The dialog's body: the current share state, and whatever can be done about it.
 *
 * Split out from {@link ShareModal} so the parent mounts it only while the dialog is open. That is
 * what resets the screen between openings — through ordinary mount-time state rather than an effect
 * that writes state on every open, which would be a cascading render. It matters here in particular
 * because a link revealed in one opening must not still be on screen at the next: the server cannot
 * confirm it still exists, so showing it again would be a guess.
 *
 * @param props Diagram id and close handler; see {@link ShareControlsProps}.
 * @returns The dialog body for the current share state.
 */
function ShareControls({ diagramId, onClose }: ShareControlsProps) {
  const [state, setState] = useState<ShareModalState>({ phase: 'loading' });
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read once per opening, not once per editor session: a link may have been revoked from another
  // tab, and an owner opening this screen is usually asking exactly "is one active now".
  useEffect(() => {
    let cancelled = false;

    getShareStatus(diagramId)
      .then((status) => {
        if (!cancelled) {
          setState(status.active ? { phase: 'active' } : { phase: 'inactive' });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            message: error instanceof Error ? error.message : 'Could not load share status.',
            phase: 'error'
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [diagramId]);

  /**
   * Mints a link and reveals it.
   *
   * @returns A promise fulfilled once the link is on screen, or the failure reported.
   */
  const handleCreate = useCallback(async () => {
    setBusy(true);
    try {
      const share = await createShare(diagramId);
      setState({ phase: 'revealed', url: share.url });
      setCopied(false);
    } catch (error) {
      setState({
        message: error instanceof Error ? error.message : 'Could not create link.',
        phase: 'error'
      });
    } finally {
      // In a `finally` so a failure leaves a pressable button rather than a permanently disabled
      // control the visitor would have to reload to escape.
      setBusy(false);
    }
  }, [diagramId]);

  /**
   * Revokes the active link.
   *
   * @returns A promise fulfilled once the link no longer resolves, or the failure reported.
   */
  const handleRevoke = useCallback(async () => {
    setBusy(true);
    try {
      await revokeShare(diagramId);
      setState({ phase: 'inactive' });
    } catch (error) {
      setState({
        message: error instanceof Error ? error.message : 'Could not revoke link.',
        phase: 'error'
      });
    } finally {
      setBusy(false);
    }
  }, [diagramId]);

  /**
   * Copies the revealed link to the clipboard.
   *
   * A clipboard failure is swallowed rather than reported: the URL is on screen in a selectable
   * field, so the visitor can still copy it by hand, and an error about an unavailable clipboard
   * API would be about the browser rather than about their diagram.
   *
   * @param url Link to copy.
   * @returns A promise fulfilled once the attempt has finished, successfully or not.
   */
  const handleCopy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      /* The clipboard API is unavailable in an insecure context; the field is still selectable. */
    }
  }, []);

  return (
    <>
      {state.phase === 'loading' && <p className="modal__text">Loading…</p>}

      {state.phase === 'error' && (
        <p className="modal__text share-modal__error" role="alert">
          {state.message}
        </p>
      )}

      {state.phase === 'inactive' && (
        <>
          <p className="modal__text">
            Create a read-only link anyone can use to view this diagram. They cannot edit it or see
            your other diagrams.
          </p>
          <div className="modal__actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void handleCreate()}
              disabled={busy}
            >
              {busy ? 'Creating…' : 'Create link'}
            </button>
          </div>
        </>
      )}

      {state.phase === 'active' && (
        <>
          <p className="modal__text">
            A read-only link is active for this diagram. Its URL is only ever shown once, right
            after it is created, so it can&rsquo;t be displayed again here &mdash; generate a new
            link if you no longer have it, which revokes the old one.
          </p>
          <div className="modal__actions">
            <button
              type="button"
              className="button button--danger"
              onClick={() => void handleRevoke()}
              disabled={busy}
            >
              {busy ? 'Revoking…' : 'Revoke link'}
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void handleCreate()}
              disabled={busy}
            >
              {busy ? 'Creating…' : 'Generate new link'}
            </button>
          </div>
        </>
      )}

      {state.phase === 'revealed' && (
        <>
          <p className="modal__text">
            Anyone with this link can view your diagram, read-only. Copy it now &mdash; it
            won&rsquo;t be shown again.
          </p>
          <div className="share-url-field">
            <label className="properties-panel__label" htmlFor="share-url">
              Share link
            </label>
            <div className="share-url-field__row">
              {/* Read-only rather than disabled: a disabled field cannot be focused, so its
                    text cannot be selected and copied by hand when the clipboard API is
                    unavailable — which is exactly when the manual path is needed. */}
              <input
                id="share-url"
                type="text"
                value={state.url}
                readOnly
                className="share-url-field__input"
              />
              <button type="button" className="button" onClick={() => void handleCopy(state.url)}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <div className="modal__actions">
            <button
              type="button"
              className="button button--danger"
              onClick={() => void handleRevoke()}
              disabled={busy}
            >
              {busy ? 'Revoking…' : 'Revoke link'}
            </button>
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Props for {@link ShareModal}.
 */
export interface ShareModalProps {
  /**
   * Diagram whose sharing this modal manages.
   */
  diagramId: string;
  /**
   * Whether the modal is visible.
   */
  open: boolean;
  /**
   * Called when the modal is dismissed. Shared by Done, Cancel, the close control, the backdrop and
   * Escape, so there is one close path rather than five.
   */
  onClose: () => void;
}

/**
 * The owner's share controls, opened from the editor toolbar.
 *
 * The screen is shaped by one fact: the server stores only a digest of the token, so a link can be
 * displayed exactly once, in the session that created it. Everything a visitor sees here follows
 * from that rather than from a design preference — the copy field appears only after a creation,
 * the "already active" message offers no URL to copy, and the way to recover a lost link is to
 * generate a new one, which revokes the old.
 *
 * The alternative would have been to store the token so it could always be redisplayed. That is the
 * defect this port is fixing, so saying so on screen is better than quietly behaving as though the
 * link were simply mislaid.
 *
 * This component owns the dialog shell and its focus; {@link ShareControls} owns the state inside it
 * and is mounted only while the dialog is open, so each opening starts from the server's current
 * answer rather than from the last one.
 *
 * @param props Diagram id, visibility and close handler; see {@link ShareModalProps}.
 * @returns The modal, or `null` while closed.
 */
export function ShareModal({ diagramId, open, onClose }: ShareModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, onClose);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay">
      {/* A real, natively keyboard-operable button behind the dialog rather than a click handler
          on a non-interactive div. `tabIndex={-1}` keeps it out of the tab order — see
          `../../../hooks/useModalFocus.ts` — leaving Escape and the dialog's own visible controls
          as the keyboard dismissal paths. */}
      <button
        type="button"
        className="modal-overlay__backdrop"
        aria-label="Close dialog"
        onClick={onClose}
        tabIndex={-1}
      />
      {/* A `div` with `role="dialog"` rather than a native `<dialog>`, for the reason recorded in
          `../../blueprints/CreateDiagramModal.tsx`: `showModal()` and this application's shared
          focus hook do not compose, and mixing them would mean two sources of truth for focus. */}
      <div
        ref={dialogRef}
        className="modal"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-modal-title"
        tabIndex={-1}
      >
        <button className="modal__close" onClick={onClose} aria-label="Close" type="button">
          &times;
        </button>
        <h2 id="share-modal-title" className="modal__title">
          Share Diagram
        </h2>
        <ShareControls diagramId={diagramId} onClose={onClose} />
      </div>
    </div>
  );
}
