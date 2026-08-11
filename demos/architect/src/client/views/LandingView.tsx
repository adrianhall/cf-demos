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
      {/* Bug 34 (docs/09-ARCHITECT.md's Reported Issues): this is the page's primary call to
          action, but it was a bare anchor styled only with a margin, so it rendered as underlined
          body text. `.button` already opts out of the default anchor underline (Bug 30). */}
      <a className="landing__cta button button--primary" href="/app">
        Open the editor
      </a>
    </main>
  );
}
