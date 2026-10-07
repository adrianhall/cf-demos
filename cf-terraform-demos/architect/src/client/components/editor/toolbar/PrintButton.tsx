import { Printer } from 'react-feather';
import { useDiagramStore } from '../../../stores/diagramStore.ts';

/**
 * The print control.
 *
 * It only sets a flag. Every side effect of printing — forcing a light colour scheme, choosing a
 * page orientation from the diagram's shape, fitting the view, opening the browser's print dialog
 * and undoing all of it afterwards — belongs to the canvas, which is the component that owns the
 * document and the viewport. A button that reached into `document` itself could not be reasoned
 * about or tested as a button, and the canvas would have no way to clean up after it.
 *
 * Rendered in both postures, including read-only, for the same reason the export control is: an
 * anonymous visitor reading a shared diagram has every reason to want a copy of it on paper.
 *
 * @returns The print control.
 */
export function PrintButton() {
  const setPrintMode = useDiagramStore((state) => state.setPrintMode);

  return (
    <button
      type="button"
      className="toolbar__button"
      onClick={() => setPrintMode(true)}
      title="Print"
      aria-label="Print"
    >
      <Printer size={18} aria-hidden="true" />
    </button>
  );
}
