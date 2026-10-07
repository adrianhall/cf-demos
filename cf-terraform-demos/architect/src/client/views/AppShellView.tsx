import { AppHeader } from '../components/AppHeader.tsx';
import { useIdentity } from '../hooks/useIdentity.ts';
import { DashboardView } from './DashboardView.tsx';

/**
 * Every `/app*` path this shell knows how to render into `<main>`.
 */
export type AppRoute =
  | { view: 'dashboard' }
  | { view: 'editor'; diagramId: string }
  | { view: 'admin' };

/**
 * Resolves an `/app*` path into a route.
 *
 * `/app/diagram/:id` opens the editor for that diagram; `/app/admin` opens the administrative view.
 * Every other `/app*` path — including `/app` itself — falls back to the dashboard: a plain SPA has
 * no server-side router, so there is no client-side 404 within this subtree.
 *
 * Resolving to the admin route is not an authorization decision. {@link AppShellView} still decides
 * whether to render the administrative surface, and every `/api/admin/*` route re-checks the
 * verified identity server-side regardless, so a non-administrator who navigates here directly is
 * answered by the server rather than trusted by the browser.
 *
 * @param pathname Path to resolve, normally `window.location.pathname`.
 * @returns The route to render.
 */
export function resolveRoute(pathname: string): AppRoute {
  const diagramMatch = /^\/app\/diagram\/([^/]+)\/?$/u.exec(pathname);
  if (diagramMatch?.[1]) {
    return { diagramId: decodeURIComponent(diagramMatch[1]), view: 'editor' };
  }
  if (/^\/app\/admin\/?$/u.test(pathname)) {
    return { view: 'admin' };
  }
  return { view: 'dashboard' };
}

/**
 * Authenticated app shell served at `/app*`. Cloudflare Access gates this whole subtree at the edge
 * before the document request reaches the Worker or this bundle, so this component performs no
 * authentication check of its own — it displays the identity Access already verified and sub-routes
 * `<main>` between the dashboard, the editor and the administrative view.
 *
 * The identity is resolved here, once, and passed to the header: this view needs `isAdmin` for its
 * own administrative gate anyway, so letting the header resolve it too would issue a second,
 * redundant `GET /api/me` on every render.
 *
 * The editor sub-view deliberately suppresses the common header. It renders its own toolbar
 * immediately below where this would sit, whose back control already returns to a view where the
 * header and its sign-out control are available, so stacking the two produced a second banner with
 * no affordance of its own.
 *
 * **Phase 3 scope.** The dashboard is ported; the editor and the administrative surface arrive in
 * Phases 4 and 6. The header, the identity resolution and the administrative gate below are final.
 *
 * @returns The authenticated application shell.
 */
export function AppShellView() {
  const identity = useIdentity();
  const route = resolveRoute(window.location.pathname);
  const showHeader = route.view !== 'editor';

  return (
    <div className="app-shell">
      {showHeader && (
        <AppHeader
          identity={identity}
          current={route.view === 'admin' ? 'admin' : 'dashboard'}
          access="authenticated"
        />
      )}
      <main
        className={`app-shell__main${route.view === 'editor' ? ' app-shell__main--editor' : ''}`}
      >
        {route.view === 'admin' && <AdminGate identity={identity} />}
        {route.view === 'dashboard' && <DashboardView />}
        {route.view === 'editor' && <p className="app-shell__loading">Loading editor…</p>}
      </main>
    </div>
  );
}

/**
 * Decides whether to show the administrative surface, a wait state, or a refusal.
 *
 * This is presentation, not authorization. Every `/api/admin/*` route compares the verified
 * identity to `ADMIN_EMAIL` itself, so a visitor who reaches this path without being the
 * administrator is stopped by the server whatever this renders. Showing the refusal rather than the
 * dashboard is simply the honest answer to someone who asked for a page they may not have.
 *
 * The wait state matters: `isAdmin` is `false` until `/api/me` resolves, so rendering the refusal
 * immediately would flash "not allowed" at the actual administrator on every load.
 *
 * @param props Resolved identity state.
 * @returns The administrative surface placeholder, a wait state, or a refusal.
 */
function AdminGate({ identity }: { identity: ReturnType<typeof useIdentity> }) {
  if (identity.isAdmin) {
    return <p className="app-shell__loading">Loading admin…</p>;
  }
  if (identity.loading) {
    return <p className="app-shell__loading">Verifying identity…</p>;
  }
  return (
    <p className="app-shell__forbidden" role="alert">
      This page is only available to this demo&apos;s configured administrator.
    </p>
  );
}
