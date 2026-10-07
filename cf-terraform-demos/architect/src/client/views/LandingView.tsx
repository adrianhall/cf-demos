/**
 * Public landing page served for every path other than `/app*`, `/blueprints` and `/s/:token` (see
 * `../App.tsx`). Requires no Cloudflare Access identity — the hostname-wide public `bypass` Access
 * application in `infra/access.tf` covers it.
 *
 * **Phase 1 placeholder.** This renders only the hero, using the source's own class names so the
 * ported `../app.css` is genuinely exercised in a browser before any component work begins. The
 * benefit, feature, use-case and call-to-action sections, the shared `AppHeader`, and the live
 * React Flow hero diagram are ported in Phase 2 (shell and identity); nothing here is a re-authored
 * substitute for them.
 *
 * @returns The landing page.
 */
export function LandingView() {
  return (
    <div className="app-shell">
      <main className="app-shell__main landing">
        <section className="landing__hero">
          <div>
            <p className="landing__hero-eyebrow">Cloudflare architecture diagrams</p>
            <h1 className="landing__hero-title">Design your Cloudflare architecture, visually.</h1>
            <p className="landing__hero-subtitle">
              Drag real Cloudflare products onto a canvas, connect them the way your requests
              actually flow, and get a living diagram you can share, export, and hand off to an AI
              agent to keep up to date.
            </p>
            <div className="landing__hero-actions">
              <a className="button button--primary" href="/app">
                Open the editor
              </a>
              <a className="button" href="/blueprints">
                Browse blueprints
              </a>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
