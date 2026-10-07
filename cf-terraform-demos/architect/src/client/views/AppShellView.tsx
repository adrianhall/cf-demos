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
 * The editor sub-view deliberately suppresses the common header: it renders its own toolbar
 * immediately below, whose back control already returns to a view where the header and its sign-out
 * control are available.
 *
 * **Phase 1 placeholder.** The header, dashboard, editor and admin surfaces are ported in Phases 2,
 * 3, 4 and 6 respectively; this renders only the resolved route's name so the `/app*` boundary and
 * its real browser navigation can be exercised end to end first.
 *
 * @returns The authenticated application shell.
 */
export function AppShellView() {
  const route = resolveRoute(window.location.pathname);

  return (
    <div className="app-shell">
      <main
        className={`app-shell__main${route.view === 'editor' ? ' app-shell__main--editor' : ''}`}
      >
        <p className="app-shell__loading">Loading {route.view}…</p>
      </main>
    </div>
  );
}
