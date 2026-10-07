import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { getSharedDiagram, type SharedDiagram } from '../api/shares.ts';
import { DiagramCanvas } from '../components/editor/DiagramCanvas.tsx';

/**
 * What the viewer is doing at any moment.
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; diagram: SharedDiagram };

/**
 * Props for {@link ShareView}.
 */
export interface ShareViewProps {
  /**
   * Share token parsed from the `/s/:token` path by `../App.tsx`.
   *
   * Opaque here: the client never hashes, validates or interprets it, because only the server holds
   * the digest it is compared against. It is carried to the resolver and used for nothing else — in
   * particular it is never rendered, so it cannot end up in a screenshot or a bug report attached
   * to a page the reporter was looking at.
   */
  token: string;
}

/**
 * The public, anonymous read-only diagram viewer served at `/s/:token`.
 *
 * Needs no Cloudflare Access identity: this path is covered by the hostname-wide public bypass
 * application, and the only request it makes is to the public share resolver — never to the
 * owner-authenticated diagram endpoints, which would answer `401` for exactly the visitor this page
 * exists for.
 *
 * The canvas is the editor's own component in its read-only posture rather than a second viewer.
 * The point of a shared link is that the recipient sees what the owner sees, which is far more
 * convincingly true when it is rendered by the same code.
 *
 * @param props Share token from the path; see {@link ShareViewProps}.
 * @returns The read-only viewer, a loading state, or the refusal that stopped it loading.
 */
export function ShareView({ token }: ShareViewProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    getSharedDiagram(token)
      .then((diagram) => {
        if (!cancelled) {
          setState({ diagram, status: 'ready' });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            // The server's own uniform wording. A malformed, unknown, revoked and deleted link
            // are indistinguishable on purpose, so this page must not invent a message that
            // tells them apart.
            message: error instanceof Error ? error.message : 'Share link not found or revoked.',
            status: 'error'
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === 'loading') {
    return (
      <div className="app-shell">
        <main className="app-shell__main share-view">
          <p className="share-view__loading">Loading shared diagram…</p>
        </main>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="app-shell">
        <main className="app-shell__main share-view">
          {/* Announced, because for most visitors the only other evidence is a page that never
              finished loading. */}
          <div className="share-view__error" role="alert">
            <p>{state.message}</p>
            <a href="/">Go to Architect</a>
          </div>
        </main>
      </div>
    );
  }

  return (
    // A `<main>` landmark of its own: every other top-level view has one, and without it an
    // anonymous visitor on this page has nothing to skip to.
    <main className="share-view">
      <div className="share-view__banner">
        <span>You&rsquo;re viewing a shared diagram, read-only.</span>
        {/* Ordinary prose link treatment rather than the chrome `nav-link` class, because this
            sits in a sentence rather than in application chrome. */}
        <a href="/app">Create your own diagram &rarr;</a>
      </div>
      <ReactFlowProvider>
        <DiagramCanvas diagramId={state.diagram.id} readOnly initialDiagram={state.diagram} />
      </ReactFlowProvider>
    </main>
  );
}
