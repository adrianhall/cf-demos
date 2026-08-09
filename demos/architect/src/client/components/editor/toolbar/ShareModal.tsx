import { useCallback, useEffect, useState } from "react";
import { createShare, getShareStatus, revokeShare } from "../../../api/shares";

/**
 * The modal's possible phases. There is no phase carrying a *known-active* share's URL loaded
 * from `getShareStatus()` -- the server itself cannot recover a raw token once minted
 * (`../../../../worker/shares/types.ts`'s `ShareStatus` JSDoc), so `"active"` (a share exists,
 * but this modal does not know its link) and `"revealed"` (a share was just created or rotated
 * in this exact session, so its link is known) are deliberately distinct.
 */
type ShareModalState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "inactive" }
  | { phase: "active" }
  | { phase: "revealed"; url: string };

/**
 * Owner-only share management modal, opened from the editor toolbar's "Share" button
 * (`./Toolbar.tsx`). Lets the owner create a read-only link, copy it, rotate it (revoking the
 * previous one), or revoke it outright. Ported conceptually from CF-Architect's own
 * `ShareButton` (`src/islands/toolbar/Toolbar.tsx`), redesigned around this port's digest-only
 * token storage (docs/09-ARCHITECT.md's Decisions #3): CF-Architect could always redisplay an
 * existing link's URL because it stored the raw token; this port cannot, so a share that is
 * already active when the modal opens shows a "link already active" message with no URL,
 * rather than silently re-fetching one that does not exist server-side.
 *
 * @param diagramId Diagram this modal manages sharing for.
 * @param open Whether the modal is visible.
 * @param onClose Called when the modal is dismissed.
 */
export function ShareModal({
  diagramId,
  open,
  onClose,
}: {
  diagramId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<ShareModalState>({ phase: "loading" });
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ phase: "loading" });
    setCopied(false);
    getShareStatus(diagramId)
      .then((status) => {
        if (!cancelled) {
          setState(status.active ? { phase: "active" } : { phase: "inactive" });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            message:
              error instanceof Error
                ? error.message
                : "Could not load share status.",
            phase: "error",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, diagramId]);

  const handleCreate = useCallback(async () => {
    setBusy(true);
    try {
      const share = await createShare(diagramId);
      setState({ phase: "revealed", url: share.url });
      setCopied(false);
    } catch (error) {
      setState({
        message:
          error instanceof Error ? error.message : "Could not create link.",
        phase: "error",
      });
    } finally {
      setBusy(false);
    }
  }, [diagramId]);

  const handleRevoke = useCallback(async () => {
    setBusy(true);
    try {
      await revokeShare(diagramId);
      setState({ phase: "inactive" });
    } catch (error) {
      setState({
        message:
          error instanceof Error ? error.message : "Could not revoke link.",
        phase: "error",
      });
    } finally {
      setBusy(false);
    }
  }, [diagramId]);

  const handleCopy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      /* clipboard may be unavailable in an insecure or unsupported context */
    }
  }, []);

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
        onClick={onClose}
      />
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-modal-title"
      >
        <button
          className="modal__close"
          onClick={onClose}
          aria-label="Close"
          type="button"
        >
          &times;
        </button>
        <h2 id="share-modal-title" className="modal__title">
          Share Diagram
        </h2>

        {state.phase === "loading" && <p className="modal__text">Loading…</p>}

        {state.phase === "error" && (
          <p className="modal__text share-modal__error" role="alert">
            {state.message}
          </p>
        )}

        {state.phase === "inactive" && (
          <>
            <p className="modal__text">
              Create a read-only link anyone can use to view this diagram. They
              cannot edit it or see your other diagrams.
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
                {busy ? "Creating…" : "Create link"}
              </button>
            </div>
          </>
        )}

        {state.phase === "active" && (
          <>
            <p className="modal__text">
              A read-only link is active for this diagram. Its URL is only ever
              shown once, right after it is created, so it can&rsquo;t be
              displayed again here -- generate a new link if you no longer have
              it, which revokes the old one.
            </p>
            <div className="modal__actions">
              <button
                type="button"
                className="button button--danger"
                onClick={() => void handleRevoke()}
                disabled={busy}
              >
                {busy ? "Revoking…" : "Revoke link"}
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void handleCreate()}
                disabled={busy}
              >
                {busy ? "Creating…" : "Generate new link"}
              </button>
            </div>
          </>
        )}

        {state.phase === "revealed" && (
          <>
            <p className="modal__text">
              Anyone with this link can view your diagram, read-only. Copy it
              now -- it won&rsquo;t be shown again.
            </p>
            <div className="share-url-field">
              <label className="properties-panel__label" htmlFor="share-url">
                Share link
              </label>
              <div className="share-url-field__row">
                <input
                  id="share-url"
                  type="text"
                  value={state.url}
                  readOnly
                  className="share-url-field__input"
                />
                <button
                  type="button"
                  className="button"
                  onClick={() => void handleCopy(state.url)}
                >
                  {copied ? "Copied!" : "Copy"}
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
                {busy ? "Revoking…" : "Revoke link"}
              </button>
              <button type="button" className="button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
