import { useReactFlow } from "@xyflow/react";
import { useEffect, useState } from "react";
import { useDiagramStore } from "../../../stores/diagramStore";

/** Convert a unix timestamp (ms) to a short relative time string. */
function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

/**
 * Bottom status bar showing node/edge counts, zoom percentage, and autosave status. Ported from
 * CF-Architect's `src/islands/toolbar/StatusBar.tsx`, minus its `ShowJsonButton` debug affordance
 * -- not a user-facing feature this port carries forward.
 */
export function StatusBar({ readOnly }: { readOnly: boolean }) {
  const { saving, dirty, lastSavedAt, saveError, nodes, edges } =
    useDiagramStore();
  const { getZoom } = useReactFlow();
  const [zoom, setZoom] = useState(() => Math.round(getZoom() * 100));

  useEffect(() => {
    const interval = setInterval(
      () => setZoom(Math.round(getZoom() * 100)),
      1000,
    );
    return () => clearInterval(interval);
  }, [getZoom]);

  let saveStatus: string;
  if (readOnly) {
    saveStatus = "Read-only";
  } else if (saving) {
    saveStatus = "Saving…";
  } else if (saveError) {
    saveStatus = `Error: ${saveError}`;
  } else if (dirty) {
    saveStatus = "Unsaved changes";
  } else if (lastSavedAt) {
    saveStatus = `Saved ${timeAgo(lastSavedAt)}`;
  } else {
    saveStatus = "No changes";
  }

  return (
    <div className="status-bar" role="status">
      <span className="status-bar__item">
        {nodes.length} node{nodes.length === 1 ? "" : "s"}, {edges.length} edge
        {edges.length === 1 ? "" : "s"}
      </span>
      <span className="status-bar__item">Zoom: {zoom}%</span>
      <span
        className={`status-bar__item${saveError ? " status-bar__item--error" : ""}${
          dirty && !saving ? " status-bar__item--dirty" : ""
        }`}
      >
        {saveStatus}
      </span>
    </div>
  );
}
