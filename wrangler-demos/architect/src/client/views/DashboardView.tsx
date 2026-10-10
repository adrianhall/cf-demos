import { DiagramGrid } from "../components/dashboard/DiagramGrid";
import { SharedWithMeGrid } from "../components/dashboard/SharedWithMeGrid";

/**
 * Authenticated dashboard view rendered at `/app` (and `/app/`): the signed-in identity's own
 * diagrams (`DiagramGrid`), followed by a "Shared with me" section
 * (`SharedWithMeGrid`, docs/09C-COLLABORATIVE-EDITING.md's Collaborator Model Client section)
 * listing diagrams a colleague has granted this identity edit access to.
 */
export function DashboardView() {
  return (
    <>
      <DiagramGrid />
      <SharedWithMeGrid />
    </>
  );
}
