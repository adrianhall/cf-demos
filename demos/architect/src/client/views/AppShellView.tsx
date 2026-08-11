import { AppHeader } from "../components/AppHeader";
import { useIdentity } from "../hooks/useIdentity";
import { AdminView } from "./AdminView";
import { DashboardView } from "./DashboardView";
import { EditorView } from "./EditorView";

/** Shape every `/app*` path this view actually knows how to render into `<main>`. */
type AppRoute =
  | { view: "dashboard" }
  | { view: "editor"; diagramId: string }
  | { view: "admin" };

/**
 * Resolve the current `/app*` path into a route. `/app/diagram/:id` opens the editor for `:id`;
 * `/app/admin` opens the admin view (Phase 4) regardless of identity -- `AppShellView` itself
 * decides whether to actually render {@link AdminView} or a "not allowed" message based on
 * `isAdmin`, so a non-administrator navigating here directly never sees the admin UI, only every
 * `/api/admin/*` route's own independent `403` if they somehow did. Every other `/app*` path
 * (including `/app` itself) falls back to the dashboard -- there is no client-side 404 within
 * this subtree, matching a plain SPA with no server-side router (see the Phase 0 spike report
 * referenced by `../App.tsx`).
 */
function resolveRoute(pathname: string): AppRoute {
  const diagramMatch = /^\/app\/diagram\/([^/]+)\/?$/u.exec(pathname);
  if (diagramMatch?.[1]) {
    return { diagramId: decodeURIComponent(diagramMatch[1]), view: "editor" };
  }
  if (/^\/app\/admin\/?$/u.test(pathname)) {
    return { view: "admin" };
  }
  return { view: "dashboard" };
}

/**
 * Authenticated app shell served at `/app*`. Cloudflare Access gates this whole subtree at the
 * edge before the request ever reaches the Worker or this SPA's JavaScript (see
 * `wrangler.jsonc.tpl` and `infra/access.tf`'s `app` Access application), so this component
 * itself performs no authentication check — it only displays the identity Access already
 * verified, via `GET /api/me`, and sub-routes `<main>` between the dashboard, the editor, and
 * (for the configured administrator only) the admin view.
 *
 * The header (`../components/AppHeader.tsx`, shared with the public blueprint gallery since
 * Bug 34) is rendered for the dashboard and admin sub-views, per AGENTS.md's Public Access
 * requirement for an unconditional logout control. The identity is resolved here, once, and
 * passed down: this view needs `isAdmin` for its own admin gate anyway, so letting the header
 * call `useIdentity()` too would issue a second, redundant `GET /api/me` on `/app/admin`.
 * Bug 23 (docs/09-ARCHITECT.md Phase 9) removes it for the editor sub-view specifically
 * -- the editor already renders its own single toolbar (`../components/editor/toolbar/Toolbar.tsx`)
 * immediately below where this header used to sit, and that toolbar's own `ArrowLeft`
 * back-to-dashboard link is enough to return to a view where the header (and its sign-out
 * control) is available again, so stacking this header above the editor's toolbar added a
 * second banner with no affordance of its own that the toolbar didn't already cover.
 */
export function AppShellView() {
  const identity = useIdentity();
  const route = resolveRoute(window.location.pathname);
  const showHeader = route.view !== "editor";

  return (
    <div className="app-shell">
      {showHeader && (
        <AppHeader
          identity={identity}
          current={route.view === "admin" ? "admin" : "dashboard"}
          access="authenticated"
        />
      )}
      <main
        className={`app-shell__main${route.view === "editor" ? " app-shell__main--editor" : ""}`}
      >
        {route.view === "editor" && <EditorView diagramId={route.diagramId} />}
        {route.view === "dashboard" && <DashboardView />}
        {route.view === "admin" &&
          (identity.isAdmin ? (
            <AdminView />
          ) : identity.loading ? (
            <p className="app-shell__loading">Verifying identity…</p>
          ) : (
            <p className="app-shell__forbidden" role="alert">
              This page is only available to this demo's configured
              administrator.
            </p>
          ))}
      </main>
    </div>
  );
}
