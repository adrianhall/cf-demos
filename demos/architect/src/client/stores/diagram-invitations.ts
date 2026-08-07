import { defineStore } from "pinia";

/** Owner-visible invitation record, as returned by `/api/diagrams/:id/invitations`. */
export interface InvitationSummary {
  /** Opaque identifier used to revoke this invitation — never the raw token or its digest. */
  id: string;
  /** Diagram this invitation grants editor access to. */
  diagramId: string;
  /** Verified Cloudflare Access email of the diagram owner who created this invitation. */
  creatorEmail: string;
  /** ISO-8601 timestamp after which this invitation can no longer be redeemed. */
  expiresAt: string;
}

/** RFC 9457 response fields displayed to the caller. */
interface ProblemDetails {
  /** User-safe explanation of a failed request. */
  detail?: string;
  /** Standard status text fallback. */
  title?: string;
}

/** Extract a user-safe message from an unsuccessful same-origin API response. */
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

/** Convert an unsuccessful same-origin API response into a user-safe error. */
async function requestError(response: Response): Promise<Error> {
  return new Error(await requestErrorMessage(response));
}

/**
 * Shared client state for one diagram's owner-only invitation management: create, list, revoke.
 *
 * Redemption (`POST /api/invitations/redeem`) is a deliberately separate, non-owner-scoped flow
 * — see `./invitation-redemption.ts` — because a raw token alone already identifies its diagram;
 * this store only ever manages invitations *for a diagram the caller owns*. The Worker enforces
 * that boundary independently (`DiagramRepository.requireOwner()`); this store does not decide
 * who may call it, only renders what the API returns.
 */
export const useDiagramInvitationsStore = defineStore("diagram-invitations", {
  actions: {
    /**
     * Clear the one-time raw token from memory once the owner has copied it, so it does not
     * linger in reactive state (or a later devtools inspection) longer than necessary.
     */
    clearLastCreatedToken(): void {
      this.lastCreatedToken = "";
    },

    /**
     * Create a new invitation for a diagram and place it first in the active list.
     *
     * @param diagramId Diagram to create an invitation for.
     */
    async create(diagramId: string): Promise<void> {
      this.creating = true;
      this.error = "";
      try {
        const response = await fetch(
          `/api/diagrams/${encodeURIComponent(diagramId)}/invitations`,
          {
            body: "{}",
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) {
          throw await requestError(response);
        }
        const body = (await response.json()) as {
          invitation: InvitationSummary;
          token: string;
        };
        this.invitations.unshift(body.invitation);
        this.lastCreatedToken = body.token;
      } catch (error) {
        this.error =
          error instanceof Error
            ? error.message
            : "Could not create the invitation.";
      } finally {
        this.creating = false;
      }
    },

    /**
     * Fetch a diagram's currently active invitations.
     *
     * @param diagramId Diagram to list invitations for.
     */
    async load(diagramId: string): Promise<void> {
      this.loading = true;
      this.error = "";
      try {
        const response = await fetch(
          `/api/diagrams/${encodeURIComponent(diagramId)}/invitations`,
        );
        if (!response.ok) {
          this.error = await requestErrorMessage(response);
          return;
        }
        const body = (await response.json()) as {
          invitations: InvitationSummary[];
        };
        this.invitations = body.invitations;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Revoke one invitation and remove it from the active list.
     *
     * @param diagramId Diagram the invitation belongs to.
     * @param invitationId Invitation's opaque id (`InvitationSummary.id`).
     */
    async revoke(diagramId: string, invitationId: string): Promise<void> {
      this.error = "";
      try {
        const response = await fetch(
          `/api/diagrams/${encodeURIComponent(diagramId)}/invitations/${encodeURIComponent(invitationId)}`,
          { headers: { "Content-Type": "application/json" }, method: "DELETE" },
        );
        if (!response.ok) {
          throw await requestError(response);
        }
        this.invitations = this.invitations.filter(
          (invitation) => invitation.id !== invitationId,
        );
      } catch (error) {
        this.error =
          error instanceof Error
            ? error.message
            : "Could not revoke the invitation.";
      }
    },
  },
  state: () => ({
    /** Whether a create request is currently pending. */
    creating: false,
    /** User-safe message from the most recent failed request, if any. */
    error: "",
    /** Currently active invitations for the diagram most recently loaded. */
    invitations: [] as InvitationSummary[],
    /** The most recently created invitation's raw token, shown to the owner exactly once. */
    lastCreatedToken: "",
    /** Whether the initial load request is pending. */
    loading: false,
  }),
});
