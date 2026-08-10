import { Printer } from "react-feather";
import { useDiagramStore } from "../../../stores/diagramStore";

/**
 * Toolbar button that switches the canvas into its print-optimized view mode. Ported from
 * CF-Architect's `src/islands/toolbar/PrintButton.tsx` (docs/09-ARCHITECT.md Phase 5) — the
 * button itself only flips a flag; every side effect (forcing a light color scheme, choosing
 * page orientation, fitting the view, and calling `window.print()`) lives in
 * `../DiagramCanvas.tsx`'s print-mode effect.
 *
 * Rendered unconditionally, including in read-only mode, matching CF-Architect's own toolbar and
 * `./ExportButton.tsx`'s same rationale: an anonymous share viewer can print a diagram it cannot
 * edit.
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
