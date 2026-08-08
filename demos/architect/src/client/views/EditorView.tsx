import { ReactFlowProvider } from "@xyflow/react";
import { DiagramCanvas } from "../components/editor/DiagramCanvas";

/**
 * Authenticated editor view rendered at `/app/diagram/:id`. Wraps {@link DiagramCanvas} in a
 * `ReactFlowProvider` -- required by `@xyflow/react`'s `useReactFlow()`, used by the canvas
 * itself, the toolbar, and the status bar.
 *
 * @param diagramId Diagram id parsed from the URL by `../App.tsx`.
 */
export function EditorView({ diagramId }: { diagramId: string }) {
  return (
    <ReactFlowProvider>
      <DiagramCanvas diagramId={diagramId} />
    </ReactFlowProvider>
  );
}
