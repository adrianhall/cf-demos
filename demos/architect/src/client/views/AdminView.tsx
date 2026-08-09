import { DiagramModerationPanel } from "../components/admin/DiagramModerationPanel";
import { UserDirectoryTable } from "../components/admin/UserDirectoryTable";

/**
 * Administrator-only view rendered at `/app/admin` by `AppShellView` for the identity matching
 * `ADMIN_EMAIL` -- gated client-side by `isAdmin` from `useIdentity()`, and independently
 * enforced server-side by every `/api/admin/*` route's `requireAdmin` middleware
 * (`../../worker/middleware/admin.ts`), so a non-administrator who navigates here directly still
 * gets `403`s from every request this view makes, not just a hidden nav link
 * (docs/09-ARCHITECT.md Phase 4).
 */
export function AdminView() {
  return (
    <div className="admin">
      <h1 className="admin__title">Administration</h1>
      <section>
        <h2 className="admin__section-title">User directory</h2>
        <UserDirectoryTable />
      </section>
      <DiagramModerationPanel />
    </div>
  );
}
