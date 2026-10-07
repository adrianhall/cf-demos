import { AppHeader } from '../components/AppHeader.tsx';
import { BlueprintGallery } from '../components/blueprints/BlueprintGallery.tsx';
import { useIdentity } from '../hooks/useIdentity.ts';

/**
 * Public blueprint gallery served at `/blueprints`, outside the authenticated `/app*` subtree.
 * Reachable both by an anonymous visitor browsing available templates and by the dashboard's
 * create-diagram link — the same page either way. Only the create request the gallery's modal
 * ultimately sends requires a signed-in identity; Cloudflare Access challenges that request, not
 * this page.
 *
 * It renders the shared banner in `public` mode, which exists precisely because this page's visitor
 * may be anonymous: `/api/me` requires Access, so a failed identity request here means "not signed
 * in" rather than a fault worth alerting about, and the banner offers "Sign in" instead of "Sign
 * out".
 *
 * @returns The blueprint gallery page.
 */
export function BlueprintsView() {
  const identity = useIdentity();

  return (
    <div className="app-shell">
      <AppHeader identity={identity} current="blueprints" access="public" />
      <main className="app-shell__main blueprints-view">
        <div className="blueprints-view__intro">
          <h1>Start a new diagram</h1>
          <p>Choose a blueprint template, or start from a blank canvas.</p>
        </div>
        <BlueprintGallery />
      </main>
    </div>
  );
}
