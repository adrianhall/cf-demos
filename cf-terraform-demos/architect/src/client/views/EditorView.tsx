import { ReactFlowProvider } from '@xyflow/react';
import { DiagramCanvas } from '../components/editor/DiagramCanvas.tsx';

/**
 * Props for {@link EditorView}.
 */
export interface EditorViewProps {
  /**
   * Id of the diagram to edit, parsed from the path by the app shell.
   */
  diagramId: string;
}

/**
 * The authenticated editor, rendered at `/app/diagram/:id`.
 *
 * Its own job is the provider: `useReactFlow()` reads from React Flow's context, and the canvas,
 * the toolbar and the status bar all use it. The provider lives here rather than inside the canvas
 * so those siblings share one instance — a provider nested deeper would leave the toolbar's zoom
 * controls talking to a different canvas than the one on screen.
 *
 * @param props Diagram id; see {@link EditorViewProps}.
 * @returns The editor.
 */
export function EditorView({ diagramId }: EditorViewProps) {
  return (
    <ReactFlowProvider>
      <DiagramCanvas diagramId={diagramId} />
    </ReactFlowProvider>
  );
}
