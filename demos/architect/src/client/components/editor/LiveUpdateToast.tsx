import { useEffect } from "react";
import { useIdentity } from "../../hooks/useIdentity";
import { useDiagramStore } from "../../stores/diagramStore";

/** Auto-dismiss delay, in milliseconds, for the "Updated by…" toast. */
const AUTO_DISMISS_MS = 6_000;

/**
 * Render the toast's text for one live-update notice.
 *
 * @param actorEmail The identity that performed the edit.
 * @param origin `"human"` for a WebSocket-originated edit, `"agent"` for an MCP tool call.
 * @param viewerEmail This tab's own signed-in identity email, or `null` before it has loaded.
 * @returns "Updated by your agent" for an agent-originated edit -- true even when the agent
 * authenticates as this tab's own owner identity (docs/09C-COLLABORATIVE-EDITING.md's Interplay
 * With Demo 9B) -- "Updated by you" for this tab's own identity editing from a different browser
 * tab, or "Updated by \<email\>" for any other human collaborator.
 */
function noticeText(
  actorEmail: string,
  origin: "human" | "agent",
  viewerEmail: string | null,
): string {
  if (origin === "agent") {
    return "Updated by your agent";
  }
  if (viewerEmail !== null && actorEmail === viewerEmail) {
    return "Updated by you";
  }
  return `Updated by ${actorEmail}`;
}

/**
 * Brief, dismissible notice shown after `../../hooks/useDiagramLiveSync.ts` applies another
 * identity's live edit to the canvas (docs/09C-COLLABORATIVE-EDITING.md's Live-Editing
 * Architecture) -- without this, the canvas would silently change under the user with no
 * explanation. Auto-dismisses after a few seconds, but can also be dismissed manually; both
 * paths call the same store action (`dismissLiveUpdateNotice`), so there is exactly one code
 * path to test. Renders nothing until `../../stores/diagramStore.ts`'s `showLiveUpdateNotice()`
 * sets `liveUpdateNotice`.
 */
export function LiveUpdateToast() {
  const liveUpdateNotice = useDiagramStore((state) => state.liveUpdateNotice);
  const dismissLiveUpdateNotice = useDiagramStore(
    (state) => state.dismissLiveUpdateNotice,
  );
  const { email: viewerEmail } = useIdentity();

  useEffect(() => {
    if (liveUpdateNotice === null) return;
    const timer = setTimeout(dismissLiveUpdateNotice, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [liveUpdateNotice, dismissLiveUpdateNotice]);

  if (liveUpdateNotice === null) {
    return null;
  }

  return (
    <div className="live-update-toast" role="status" aria-live="polite">
      <span>
        {noticeText(
          liveUpdateNotice.actorEmail,
          liveUpdateNotice.origin,
          viewerEmail,
        )}
      </span>
      <button
        type="button"
        className="live-update-toast__dismiss"
        onClick={dismissLiveUpdateNotice}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}
