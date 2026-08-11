import { AppHeader } from "../components/AppHeader";
import { BlueprintGallery } from "../components/blueprints/BlueprintGallery";
import { useIdentity } from "../hooks/useIdentity";

/**
 * Public blueprint gallery served at `/blueprints`, outside the authenticated `/app*` subtree
 * (docs/09-ARCHITECT.md's Access Model: `/blueprints` is covered by the hostname-wide public
 * `bypass` Access application, not the authenticated one). Reachable both by an unauthenticated
 * visitor browsing available templates and by the dashboard's "+ New Diagram" link
 * (`../components/dashboard/DiagramGrid.tsx`) -- the same page either way. Only the create
 * request the gallery's modal ultimately sends (`POST /api/diagrams`) requires a signed-in
 * identity; Cloudflare Access challenges that request, not this page.
 *
 * Renders the same shared banner as the authenticated app shell
 * (`../components/AppHeader.tsx`), in its `public` mode (Bug 34 / GitLab issue #2). This page
 * previously carried its own ad-hoc header and its own `../components/DarkModeToggle.tsx`
 * instance, whose brand and "My Diagrams" links were plain underlined, link-coloured anchors in
 * the wrong font weight. `public` mode exists precisely because this page's visitor may be
 * anonymous: `useIdentity()`'s `GET /api/me` requires Access (`../access-policies.ts`), so a
 * failure here means "not signed in" rather than a fault worth alerting about, and the banner
 * offers "Sign in" instead of "Sign out".
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
