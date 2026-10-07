import { DiagramModerationPanel } from '../components/admin/DiagramModerationPanel.tsx';
import { UserDirectoryTable } from '../components/admin/UserDirectoryTable.tsx';

/**
 * The administrative view, rendered at `/app/admin` for the configured administrator.
 *
 * Two deliberately separate surfaces, and keeping them separate is the point. The directory answers
 * _who has used this deployment, and how much_ without naming a single diagram; the moderation
 * panel answers _what is in this diagram_ without naming its owner. Neither is a way to browse
 * somebody's work, and composing them still is not.
 *
 * `AppShellView` decides whether to render this at all, from the `isAdmin` the server reported.
 * That decision is presentation: every request this view makes is independently refused by the
 * Worker unless the verified Access identity matches `ADMIN_EMAIL`, so a visitor who reached this
 * component some other way sees two surfaces that both answer `403`.
 *
 * @returns The administrative view.
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
