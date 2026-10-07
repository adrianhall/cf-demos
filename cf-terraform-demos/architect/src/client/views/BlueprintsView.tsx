/**
 * Public blueprint gallery served at `/blueprints`, outside the authenticated `/app*` subtree.
 * Reachable both by an anonymous visitor browsing available templates and by the dashboard's
 * create-diagram link — the same page either way. Only the create request the gallery's modal
 * ultimately sends requires a signed-in identity; Cloudflare Access challenges that request, not
 * this page.
 *
 * **Phase 1 placeholder.** The gallery itself, its category filters, its real React Flow
 * thumbnails, the permanent blank-canvas card and the two-column create modal are ported in Phase 3.
 *
 * @returns The blueprint gallery page.
 */
export function BlueprintsView() {
  return (
    <div className="app-shell">
      <main className="app-shell__main blueprints-view">
        <div className="blueprints-view__intro">
          <h1>Start a new diagram</h1>
          <p>Choose a blueprint template, or start from a blank canvas.</p>
        </div>
      </main>
    </div>
  );
}
