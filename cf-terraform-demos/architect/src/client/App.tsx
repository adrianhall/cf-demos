import { AppShellView } from './views/AppShellView.tsx';
import { BlueprintsView } from './views/BlueprintsView.tsx';
import { LandingView } from './views/LandingView.tsx';
import { ShareView } from './views/ShareView.tsx';

/**
 * Root component. Chooses between the public landing page, the public blueprint gallery, the public
 * read-only share viewer, and the authenticated app shell by the current path, read once at render
 * time — not a client-side route the app itself transitions between.
 *
 * The boundary between `/app*` and everything else is always a real browser navigation, never a
 * history push: `/app*` requires a verified Cloudflare Access identity, and only a full document
 * request lets Access — or, locally, `cloudflareAccessPlugin()` — intercept it before this bundle
 * runs. A client-side router would resolve the path inside an already-loaded bundle, which is
 * exactly the interception point this design needs to keep.
 *
 * `/blueprints` and `/s/:token` need no such interception: both are public either way, so they are
 * reachable identically whether or not the visitor is signed in.
 *
 * @returns The view matching `window.location.pathname`.
 */
export function App() {
  const { pathname } = window.location;
  if (pathname.startsWith('/app')) {
    return <AppShellView />;
  }
  if (pathname === '/blueprints') {
    return <BlueprintsView />;
  }
  const shareMatch = /^\/s\/([^/]+)\/?$/u.exec(pathname);
  if (shareMatch?.[1]) {
    return <ShareView token={decodeURIComponent(shareMatch[1])} />;
  }
  return <LandingView />;
}
