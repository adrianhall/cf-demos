import { defineStore } from "pinia";
import type { GraphDocument } from "../../graph/types";

/** RFC 9457 response fields displayed to the caller. */
interface ProblemDetails {
  /** User-safe explanation of a failed request. */
  detail?: string;
  /** Standard status text fallback. */
  title?: string;
}

/** Convert an unsuccessful `POST /shared/resolve` response into a user-safe error message. */
async function requestErrorMessage(response: Response): Promise<string> {
  try {
    const problem = (await response.json()) as ProblemDetails;
    return problem.detail ?? problem.title ?? "This share link is not valid.";
  } catch {
    return "This share link is not valid.";
  }
}

/**
 * Shared client state for the public, anonymous `/share` read-only viewer
 * (`docs/09-ARCHITECT.md`'s Phase 6).
 *
 * This is intentionally the only client code that ever reads the raw share token from
 * `window.location.hash` — it sends it once, in a same-origin JSON body, to
 * `POST /shared/resolve`, and never stores, logs, or otherwise persists it beyond the single
 * in-flight request. This store never opens a WebSocket and never calls any authenticated
 * `/api/*` route.
 */
export const useSharedViewerStore = defineStore("shared-viewer", {
  actions: {
    /**
     * Resolve one raw share token to its currently published snapshot.
     *
     * @param token Raw token, from `window.location.hash` with its leading `#` already removed.
     */
    async resolve(token: string): Promise<void> {
      this.loading = true;
      this.error = "";
      this.title = "";
      this.document = null;
      try {
        const response = await fetch("/shared/resolve", {
          body: JSON.stringify({ token }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!response.ok) {
          this.error = await requestErrorMessage(response);
          return;
        }
        const body = (await response.json()) as {
          document: GraphDocument;
          revision: number;
          title: string;
        };
        this.title = body.title;
        this.revision = body.revision;
        this.document = body.document;
      } catch {
        this.error =
          "Could not reach the server. Check your connection and try again.";
      } finally {
        this.loading = false;
      }
    },
  },
  state: () => ({
    /** The resolved snapshot's graph document, or `null` before/failing to resolve. */
    document: null as GraphDocument | null,
    /** User-safe message from the most recent failed resolution, if any. */
    error: "",
    /** Whether a resolve request is currently pending. */
    loading: false,
    /** The resolved snapshot's published revision. */
    revision: 0,
    /** The resolved snapshot's diagram title. */
    title: "",
  }),
});
