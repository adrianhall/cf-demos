import { useIdentity } from "../hooks/useIdentity";

/**
 * Authenticated app shell served at `/app*`. Cloudflare Access gates this whole subtree at the
 * edge before the request ever reaches the Worker or this SPA's JavaScript (see
 * `wrangler.jsonc.tpl` and `infra/access.tf`'s `app` Access application), so this component
 * itself performs no authentication check — it only displays the identity Access already
 * verified, via `GET /api/me`.
 *
 * Phase 1 renders an empty shell; Phase 2 replaces the placeholder main content with the
 * diagram dashboard and editor.
 */
export function AppShellView() {
  const identity = useIdentity();

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <span className="app-shell__name">Architect</span>
        {identity.loading ? (
          <span className="app-shell__identity">Verifying identity…</span>
        ) : identity.email !== null ? (
          <span className="app-shell__identity">
            {identity.email}
            {identity.isAdmin ? " (administrator)" : ""}
          </span>
        ) : (
          <span className="app-shell__identity" role="alert">
            {identity.error}
          </span>
        )}
        {/* Unconditionally rendered per AGENTS.md's Public Access section, so a presenter who
            signs in as the wrong identity locally can always recover without clearing cookies. */}
        <a className="app-shell__logout" href="/cdn-cgi/access/logout">
          Sign out
        </a>
      </header>
      <main className="app-shell__main">
        <p>Your diagrams will appear here.</p>
      </main>
    </div>
  );
}
