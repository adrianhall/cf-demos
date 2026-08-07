import { defineStore } from "pinia";

/** A diagram's current publication status, as returned by `GET /api/diagrams/:id/share`. */
export interface ShareStatus {
  /** Whether this diagram currently has an active (non-revoked) published snapshot. */
  published: boolean;
  /** The published revision, present only when {@link published} is `true`. */
  revision?: number;
  /** ISO-8601 timestamp of the first publish, present only when {@link published} is `true`. */
  createdAt?: string;
  /** ISO-8601 timestamp of the most recent publish/republish. */
  updatedAt?: string;
}

/** RFC 9457 response fields displayed to the caller. */
interface ProblemDetails {
  /** User-safe explanation of a failed request. */
  detail?: string;
  /** Standard status text fallback. */
  title?: string;
}

/** Convert an unsuccessful same-origin API response into a user-safe error message. */
async function requestErrorMessage(response: Response): Promise<string> {
  try {
    const problem = (await response.json()) as ProblemDetails;
    return (
      problem.detail ?? problem.title ?? "The request could not be completed."
    );
  } catch {
    return "The request could not be completed.";
  }
}

/**
 * Shared client state for one diagram's owner-only publish/republish/revoke controls
 * (`docs/09-ARCHITECT.md`'s Phase 6). The Worker enforces the owner-only boundary independently
 * (`DiagramRepository.requireOwner()`); this store only renders what the API returns.
 *
 * The raw share token is shown to the owner only once — from a *first* publish's response — and
 * never again, mirroring `./diagram-invitations.ts`'s invitation-token pattern for exactly the
 * same reason: the server itself never persists it. A republish keeps the same underlying link
 * (only the pointed-at revision changes) but this store's `lastToken` is only ever set when the
 * API actually returns a fresh one.
 */
export const useDiagramShareStore = defineStore("diagram-share", {
  actions: {
    /** Forget the one-time raw token from memory once the owner has copied it. */
    clearLastToken(): void {
      this.lastToken = "";
    },

    /**
     * Fetch a diagram's current publication status.
     *
     * @param diagramId Diagram to read share status for.
     */
    async load(diagramId: string): Promise<void> {
      this.loading = true;
      this.error = "";
      try {
        const response = await fetch(
          `/api/diagrams/${encodeURIComponent(diagramId)}/share`,
        );
        if (!response.ok) {
          this.error = await requestErrorMessage(response);
          return;
        }
        const body = (await response.json()) as { status: ShareStatus };
        this.status = body.status;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Publish (or republish/update) a diagram's current document.
     *
     * @param diagramId Diagram to publish.
     */
    async publish(diagramId: string): Promise<void> {
      this.publishing = true;
      this.error = "";
      try {
        const response = await fetch(
          `/api/diagrams/${encodeURIComponent(diagramId)}/share`,
          {
            body: "{}",
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) {
          this.error = await requestErrorMessage(response);
          return;
        }
        const body = (await response.json()) as {
          published: boolean;
          revision: number;
          token: string | null;
        };
        this.status = { published: body.published, revision: body.revision };
        if (body.token) {
          this.lastToken = body.token;
        }
      } finally {
        this.publishing = false;
      }
    },

    /**
     * Revoke a diagram's active share.
     *
     * @param diagramId Diagram to revoke publication for.
     */
    async revoke(diagramId: string): Promise<void> {
      this.error = "";
      try {
        const response = await fetch(
          `/api/diagrams/${encodeURIComponent(diagramId)}/share`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          this.error = await requestErrorMessage(response);
          return;
        }
        this.status = { published: false };
        this.lastToken = "";
      } catch {
        this.error = "Could not revoke this share.";
      }
    },
  },
  state: () => ({
    /** User-safe message from the most recent failed request, if any. */
    error: "",
    /** The most recently *newly generated* raw token, shown to the owner exactly once. */
    lastToken: "",
    /** Whether the initial status load request is pending. */
    loading: false,
    /** Whether a publish request is currently pending. */
    publishing: false,
    /** The diagram's current publication status, or `null` before it has been loaded. */
    status: null as ShareStatus | null,
  }),
});
