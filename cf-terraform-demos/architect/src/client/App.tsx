import { MCP_GUIDE_ROUTE } from '../mcp-route.ts';
import { AppShellView } from './views/AppShellView.tsx';
import { BlueprintsView } from './views/BlueprintsView.tsx';
import { LandingView } from './views/LandingView.tsx';
import { McpGuideView } from './views/McpGuideView.tsx';
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
 * `/blueprints`, `/guides/mcp` and `/s/:token` need no such interception: all three are public
 * either way, so they are reachable identically whether or not the visitor is signed in. The guide
 * page is public for a stronger reason than the other two — it explains how to sign in, so putting
 * it behind a login would make it useless exactly when it is needed. See `MCP_GUIDE_ROUTE` in
 * `../mcp-route.ts` for the path prefix it must stay clear of to keep that posture.
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
  if (pathname === MCP_GUIDE_ROUTE) {
    return <McpGuideView />;
  }
  const shareMatch = /^\/s\/([^/]+)\/?$/u.exec(pathname);
  if (shareMatch?.[1]) {
    return <ShareView token={decodeURIComponent(shareMatch[1])} />;
  }
  return <LandingView />;
}
