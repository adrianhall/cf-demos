import { useEffect } from "react";
import { useDiagramStore } from "../../stores/diagramStore";

/** Auto-dismiss delay, in milliseconds, for the "Updated by an agent" toast. */
const AUTO_DISMISS_MS = 6_000;

/**
 * Brief, dismissible notice shown after `../../hooks/useDiagramLiveSync.ts` replaces the canvas
 * with a graph pushed by a remote MCP tool call (docs/09B-ARCHITECT-MCP.md's Live Sync
 * Architecture) -- without this, the canvas would silently rewrite itself under the user with no
 * explanation of why. Auto-dismisses after a few seconds, but can also be dismissed manually;
 * both paths call the same store action (`dismissLiveUpdateNotice`), so there is exactly one
 * code path to test. Renders nothing until `../../stores/diagramStore.ts`'s
 * `applyRemoteGraphUpdate()` sets `liveUpdateNotice`.
 */
export function LiveUpdateToast() {
  const liveUpdateNotice = useDiagramStore((state) => state.liveUpdateNotice);
  const dismissLiveUpdateNotice = useDiagramStore(
    (state) => state.dismissLiveUpdateNotice,
  );

  useEffect(() => {
    if (!liveUpdateNotice) return;
    const timer = setTimeout(dismissLiveUpdateNotice, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [liveUpdateNotice, dismissLiveUpdateNotice]);

  if (!liveUpdateNotice) {
    return null;
  }

  return (
    <div className="live-update-toast" role="status" aria-live="polite">
      <span>Updated by an agent</span>
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
