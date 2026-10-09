import { DiagramGrid } from '../components/dashboard/DiagramGrid.tsx';
import { SharedWithMeGrid } from '../components/dashboard/SharedWithMeGrid.tsx';

/**
 * The authenticated dashboard rendered at `/app`.
 *
 * Two sections, in one deliberate order: the visitor's own diagrams, then the diagrams other people
 * have given them edit access to. They are separate components over separate endpoints rather than
 * one list with a filter, which mirrors the server exactly — the owner-scoped list is the contract
 * the MCP tool surface relies on, so collaboration was added beside it rather than inside it. The
 * two sets never overlap, because an owner cannot be a collaborator on their own diagram.
 *
 * Each section loads independently, so a failure or a slow response in one does not hold up or
 * blank the other. The shared section renders nothing at all when there is nothing in it; see
 * {@link SharedWithMeGrid} for why that is better than a standing empty state.
 *
 * @returns The dashboard's content.
 */
export function DashboardView() {
  return (
    <>
      <DiagramGrid />
      <SharedWithMeGrid />
    </>
  );
}
