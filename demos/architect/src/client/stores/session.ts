import { defineStore } from "pinia";

/** Identity response from the authenticated Worker endpoint. */
interface SessionResponse {
  /** Verified Cloudflare Access email. */
  email: string;
}

/** Shared authenticated-user state for protected browser views. */
export const useSessionStore = defineStore("session", {
  state: () => ({ email: "", error: "", loading: false }),
  actions: {
    /** Fetch and retain the current Access identity. */
    async load(): Promise<void> {
      this.loading = true;
      this.error = "";
      try {
        const response = await fetch("/api/me");
        if (!response.ok)
          throw new Error("Unable to confirm your Cloudflare Access identity.");
        const body = (await response.json()) as SessionResponse;
        this.email = body.email;
      } catch (error: unknown) {
        this.error =
          error instanceof Error
            ? error.message
            : "Unable to confirm your Cloudflare Access identity.";
      } finally {
        this.loading = false;
      }
    },
  },
});
