/**
 * Render the public landing page without requiring a Cloudflare Access identity.
 *
 * The administrative UI deliberately remains at `/admin`, where Cloudflare Access challenges the
 * visitor before management controls or API requests are available. Public short-link redirects
 * live at `/l/:code`.
 *
 * @returns A public introduction to the short-link service and its two distinct surfaces.
 */
export default function HomePage(): React.JSX.Element {
  return (
    <main className="container">
      <header className="header">
        <div>
          <p className="eyebrow">Cloudflare Workers KV</p>
          <h1>Link</h1>
          <p>Create short redirects that are managed at the edge.</p>
        </div>
        <a className="button" href="/admin">
          Manage links
        </a>
      </header>

      <section className="card" aria-labelledby="public-links-heading">
        <h2 id="public-links-heading">Public short links</h2>
        <p>
          A short URL at <code>/l/:code</code> redirects visitors to its configured destination.
        </p>
        <p>
          Administrators can sign in to manage destinations. Public visitors never need an Access
          identity to follow an existing short URL.
        </p>
      </section>
    </main>
  );
}
