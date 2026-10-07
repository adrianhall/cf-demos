import type { ReactElement } from 'react';

/**
 * Props for {@link ShareView}.
 */
export interface ShareViewProps {
  /**
   * Share token parsed from the `/s/:token` path by `../App.tsx`. Opaque here: the client never
   * hashes, validates or interprets it, because only the server holds the digest it is compared
   * against.
   */
  token: string;
}

/**
 * Public, anonymous read-only diagram viewer served at `/s/:token`. Needs no Cloudflare Access
 * identity: it is covered by the hostname-wide public `bypass` Access application, and it calls
 * only the public share resolver — never the owner-authenticated diagram endpoints.
 *
 * **Phase 1 placeholder.** Share resolution, the read-only canvas and the share banner are ported
 * in Phase 5, alongside the digest-only token storage they depend on. The token is accepted and
 * deliberately rendered nowhere: a share token is a bearer credential, and echoing it into the
 * document would put it in screenshots and bug reports for no benefit.
 *
 * @param props Share token parsed from the path.
 * @returns The read-only share viewer page.
 */
export function ShareView(props: ShareViewProps): ReactElement {
  // Accepted now so `../App.tsx`'s path selector is the finished article, consumed in Phase 5.
  void props.token;

  return (
    <div className="app-shell">
      <main className="app-shell__main share-view">
        <p className="share-view__loading">Loading shared diagram…</p>
      </main>
    </div>
  );
}
