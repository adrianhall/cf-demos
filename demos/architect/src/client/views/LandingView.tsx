/**
 * Public landing page served for every path other than `/app*` (see `App.tsx`). Requires no
 * Cloudflare Access identity — Terraform's public `bypass` Access application covers this whole
 * hostname (`infra/access.tf`).
 */
export function LandingView() {
  return (
    <main className="landing">
      <h1>Architect</h1>
      <p>
        A Cloudflare architecture diagram editor. Sign in to create, edit, and
        share diagrams built from a curated Cloudflare product catalog.
      </p>
      <a className="landing__cta" href="/app">
        Open the editor
      </a>
    </main>
  );
}
