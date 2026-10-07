import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useDiagramStore } from '../../../stores/diagramStore.ts';

/**
 * How often the zoom reading is refreshed, in milliseconds.
 */
const ZOOM_POLL_MS = 1_000;

/**
 * Converts a save timestamp into a short relative phrase.
 *
 * Deliberately coarse. The status bar answers "is my work safe", not "exactly when was it saved",
 * and a seconds-accurate figure would redraw constantly while saying nothing more.
 *
 * @param timestamp Unix timestamp of the save, in milliseconds.
 * @returns A phrase such as `just now`, `30s ago` or `2m ago`.
 */
function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1_000);

  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  return `${Math.floor(seconds / 60)}m ago`;
}

/**
 * Props for {@link StatusBar}.
 */
export interface StatusBarProps {
  /**
   * Whether the canvas is read-only, in which case the save state is replaced by that fact — a
   * viewer with nothing to save should not be told their changes are unsaved.
   */
  readOnly: boolean;
}

/**
 * The editor's status bar: how big the diagram is, how far it is zoomed, and whether it is saved.
 *
 * An `<output>`, which carries the `status` role natively, so a change here is announced without
 * stealing focus from the canvas. The save state is why the region exists at all: autosave is
 * silent by design, and this is the only place that says whether it has happened, is happening, or
 * has failed.
 *
 * @param props Read-only flag; see {@link StatusBarProps}.
 * @returns The status bar.
 */
export function StatusBar({ readOnly }: StatusBarProps) {
  const { saving, dirty, lastSavedAt, saveError, nodes, edges } = useDiagramStore();
  const { getZoom } = useReactFlow();
  const [zoom, setZoom] = useState(() => Math.round(getZoom() * 100));

  // Polled rather than driven by a viewport subscription: zoom changes continuously during a
  // pinch or a scroll, and re-rendering the status bar on every frame of that would cost more
  // than the reading is worth. A second's lag on a percentage nobody is watching closely is not a
  // defect.
  useEffect(() => {
    const interval = setInterval(() => setZoom(Math.round(getZoom() * 100)), ZOOM_POLL_MS);
    return () => clearInterval(interval);
  }, [getZoom]);

  let saveStatus: string;
  if (readOnly) {
    saveStatus = 'Read-only';
  } else if (saving) {
    saveStatus = 'Saving…';
  } else if (saveError) {
    saveStatus = `Error: ${saveError}`;
  } else if (dirty) {
    saveStatus = 'Unsaved changes';
  } else if (lastSavedAt) {
    saveStatus = `Saved ${timeAgo(lastSavedAt)}`;
  } else {
    saveStatus = 'No changes';
  }

  return (
    <output className="status-bar">
      <span className="status-bar__item">
        {nodes.length} node{nodes.length === 1 ? '' : 's'}, {edges.length} edge
        {edges.length === 1 ? '' : 's'}
      </span>
      <span className="status-bar__item">Zoom: {zoom}%</span>
      <span
        className={`status-bar__item${saveError ? ' status-bar__item--error' : ''}${
          dirty && !saving ? ' status-bar__item--dirty' : ''
        }`}
      >
        {saveStatus}
      </span>
    </output>
  );
}
