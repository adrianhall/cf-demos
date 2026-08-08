import { AppShellView } from "./views/AppShellView";
import { BlueprintsView } from "./views/BlueprintsView";
import { LandingView } from "./views/LandingView";

/**
 * Root component. Chooses between the public landing page, the public blueprint gallery, and
 * the authenticated app shell by the current path, read once at render time — not a client-side
 * route the app itself transitions between.
 *
 * The boundary between `/app*` and everything else is always a real browser navigation
 * (`LandingView`'s `<a href="/app">`, `AppShellView`'s `<a href="/cdn-cgi/access/logout">`),
 * never a client-side history push: `/app*` requires a verified Cloudflare Access identity, and
 * only a full document request lets Access (or, locally, `cloudflareAccessPlugin()`) intercept
 * it before this bundle runs. See the Phase 0 spike report for why a plain SPA has no
 * server-side router to resolve this for free the way CF-Architect's Astro file-based routing
 * did. `/blueprints` needs no such interception -- it is public either way
 * (docs/09-ARCHITECT.md's Access Model) -- so `BlueprintsView` is reachable identically whether
 * or not the visitor is signed in.
 */
export function App() {
  const { pathname } = window.location;
  if (pathname.startsWith("/app")) {
    return <AppShellView />;
  }
  if (pathname === "/blueprints") {
    return <BlueprintsView />;
  }
  return <LandingView />;
}
