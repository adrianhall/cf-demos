import { Maximize2, Minimize2 } from 'react-feather';
import { useDiagramStore } from '../../../stores/diagramStore.ts';
import { PropertiesPanel } from './PropertiesPanel.tsx';

/**
 * The editor's right-hand sidebar slot.
 *
 * It owns the slot's width, border and — below the responsive breakpoint — its position as an
 * overlay drawer, leaving {@link PropertiesPanel} to be nothing but the content that fills it.
 * Separating the two is what lets the panel be widened without the properties form knowing it has
 * been, and it is where a later layer's second tab arrives without touching that form at all.
 *
 * The width control is a toggle button rather than a drag handle: a drag has no keyboard
 * equivalent, and two widths are the whole of what the layout actually offers.
 *
 * @returns The details panel.
 */
export function DetailsPanel() {
  const detailsPanelExpanded = useDiagramStore((state) => state.detailsPanelExpanded);
  const toggleDetailsPanelExpanded = useDiagramStore((state) => state.toggleDetailsPanelExpanded);

  const label = detailsPanelExpanded ? 'Collapse panel' : 'Expand panel';

  return (
    <div className={`details-panel${detailsPanelExpanded ? ' details-panel--expanded' : ''}`}>
      <div className="details-panel__header">
        <div className="details-panel__tablist">
          <span className="details-panel__tab details-panel__tab--active">Properties</span>
        </div>
        <button
          type="button"
          onClick={toggleDetailsPanelExpanded}
          className="details-panel__expand-toggle"
          aria-pressed={detailsPanelExpanded}
          title={label}
          aria-label={label}
        >
          {detailsPanelExpanded ? (
            <Minimize2 size={16} aria-hidden="true" />
          ) : (
            <Maximize2 size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      <div className="details-panel__tabpanel">
        <PropertiesPanel />
      </div>
    </div>
  );
}
