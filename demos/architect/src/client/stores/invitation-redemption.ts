import { defineStore } from "pinia";

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
 * Shared client state for the protected `/app/invitations/:token` redemption flow.
 *
 * This is intentionally the only client code that ever reads a raw invitation token — it sends
 * it once, in a same-origin JSON body, to `POST /api/invitations/redeem`, and never stores or
 * logs it beyond the single in-flight request.
 */
export const useInvitationRedemptionStore = defineStore(
  "invitation-redemption",
  {
    actions: {
      /**
       * Redeem a raw invitation token for the signed-in identity.
       *
       * @param token Raw token from the `/app/invitations/:token` route param.
       * @returns The invitation's diagram id on success, or `undefined` on failure (see `error`).
       */
      async redeem(token: string): Promise<string | undefined> {
        this.pending = true;
        this.error = "";
        try {
          const response = await fetch("/api/invitations/redeem", {
            body: JSON.stringify({ token }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          if (!response.ok) {
            this.error = await requestErrorMessage(response);
            return undefined;
          }
          const body = (await response.json()) as { diagramId: string };
          this.diagramId = body.diagramId;
          return body.diagramId;
        } catch {
          this.error =
            "Could not reach the server. Check your connection and try again.";
          return undefined;
        } finally {
          this.pending = false;
        }
      },
    },
    state: () => ({
      /** The invitation's diagram id after a successful redemption, or empty before/on failure. */
      diagramId: "",
      /** User-safe message from the most recent failed redemption, if any. */
      error: "",
      /** Whether a redemption request is currently pending. */
      pending: false,
    }),
  },
);
