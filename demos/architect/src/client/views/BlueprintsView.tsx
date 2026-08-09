import { BlueprintGallery } from "../components/blueprints/BlueprintGallery";
import { DarkModeToggle } from "../components/DarkModeToggle";

/**
 * Public blueprint gallery served at `/blueprints`, outside the authenticated `/app*` subtree
 * (docs/09-ARCHITECT.md's Access Model: `/blueprints` is covered by the hostname-wide public
 * `bypass` Access application, not the authenticated one). Reachable both by an unauthenticated
 * visitor browsing available templates and by the dashboard's "+ New Diagram" link
 * (`../components/dashboard/DiagramGrid.tsx`) -- the same page either way. Only the create
 * request the gallery's modal ultimately sends (`POST /api/diagrams`) requires a signed-in
 * identity; Cloudflare Access challenges that request, not this page.
 *
 * Carries its own `../components/DarkModeToggle.tsx` instance (Phase 5), matching CF-Architect's
 * own `blueprints.astro`: this page renders outside `../views/AppShellView.tsx`'s header, so it
 * needs the toggle available here rather than relying on that shared instance.
 */
export function BlueprintsView() {
  return (
    <main className="blueprints-view">
      <header className="blueprints-view__header">
        <a href="/" className="blueprints-view__logo">
          Architect
        </a>
        <a href="/app" className="blueprints-view__dashboard-link">
          My Diagrams
        </a>
        <DarkModeToggle />
      </header>
      <div className="blueprints-view__intro">
        <h1>Start a new diagram</h1>
        <p>Choose a blueprint template, or start from a blank canvas.</p>
      </div>
      <BlueprintGallery />
    </main>
  );
}
