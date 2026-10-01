import { defineStore } from 'pinia';

/**
 * Cloudflare Access identity state for the current browser session.
 *
 * In production the page itself is served by the `ASSETS` binding behind a Cloudflare Access
 * application that gates the whole hostname (see `cloudflare.config.ts` and `infra/access.tf`), so
 * by the time this code runs the visitor is already authenticated — but the browser has no
 * trustworthy copy of _who_ they are. This store calls `/api/me` to obtain the Worker's verified
 * view of the identity, which is the only version worth displaying.
 *
 * Displaying it matters more here than in a typical demo: the Playground records this same verified
 * email in AI Gateway metadata for every inference request, so the shell showing
 * "alice@example.com" is also telling the visitor which name will appear against their spending.
 *
 * It is also how the UI notices an expired Access session: once the JWT is no longer valid,
 * `/api/me` answers `401` and `email` stays `null`.
 */
export const useSessionStore = defineStore('session', {
  actions: {
    /**
     * Fetch the verified identity from the Worker.
     *
     * @returns A promise fulfilled after `email` and `loading` are updated. A failure is recorded
     *   in `error` rather than thrown, because the panels are still usable while the identity
     *   indicator is unavailable.
     */
    async load(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const response = await fetch('/api/me');
        if (!response.ok) {
          throw new Error('Your session could not be verified.');
        }
        const identity = (await response.json()) as { email: string };
        this.email = identity.email;
      } catch (cause) {
        this.email = null;
        this.error =
          cause instanceof Error
            ? cause.message
            : 'Could not verify your Cloudflare Access identity.';
      } finally {
        this.loading = false;
      }
    }
  },
  state: () => ({
    /**
     * Verified identity email, or `null` before {@link useSessionStore.load} succeeds.
     */
    email: null as string | null,
    /**
     * Whether an identity request is currently pending.
     */
    loading: false,
    /**
     * Message from a failed identity check, or `null`.
     */
    error: null as string | null
  })
});
