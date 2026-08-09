import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useState } from "react";
import { getSharedDiagram, type SharedDiagram } from "../api/shares";
import { DiagramCanvas } from "../components/editor/DiagramCanvas";

/** Load state for the anonymous share viewer. */
type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; diagram: SharedDiagram };

/**
 * Public, anonymous read-only diagram viewer served at `/s/:token` (docs/09-ARCHITECT.md's
 * Phase 3). Needs no Cloudflare Access identity: it is covered by the hostname-wide public
 * `bypass` Access application in production (`infra/access.tf`), and calls only the public,
 * unauthenticated `GET /api/share/:token` (`../api/shares.ts`'s `getSharedDiagram()`) -- never
 * the owner-authenticated `getDiagram()` `../api/diagrams.ts` uses.
 *
 * @param token Share token parsed from the URL by `../App.tsx`.
 */
export function ShareView({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    getSharedDiagram(token)
      .then((diagram) => {
        if (!cancelled) setState({ diagram, status: "ready" });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            message:
              error instanceof Error
                ? error.message
                : "Share link not found or revoked.",
            status: "error",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === "loading") {
    return <p className="share-view__loading">Loading shared diagram…</p>;
  }

  if (state.status === "error") {
    return (
      <div className="share-view__error" role="alert">
        <p>{state.message}</p>
        <a href="/">Go to Architect</a>
      </div>
    );
  }

  return (
    <div className="share-view">
      <div className="share-view__banner">
        <span>You&rsquo;re viewing a shared diagram, read-only.</span>
        <a href="/app">Create your own diagram &rarr;</a>
      </div>
      <ReactFlowProvider>
        <DiagramCanvas
          diagramId={state.diagram.id}
          readOnly
          initialDiagram={state.diagram}
        />
      </ReactFlowProvider>
    </div>
  );
}
