import { DiagramGrid } from '../components/dashboard/DiagramGrid.tsx';

/**
 * The authenticated dashboard rendered at `/app`.
 *
 * A thin wrapper around {@link DiagramGrid} rather than the grid mounted directly by the shell: the
 * later phases add further sections to this page — diagrams shared with the visitor, and the
 * administrative entry point — and this is where they will sit, next to the grid rather than inside
 * it.
 *
 * @returns The dashboard's content.
 */
export function DashboardView() {
  return <DiagramGrid />;
}
