import { defineStore } from 'pinia';
import { requestJson } from '../lib/api';

/**
 * Cloudflare Access identity state for the current browser session.
 *
 * In production the page itself is served by the `ASSETS` binding behind a Cloudflare Access
 * application that gates the whole hostname (see `cloudflare.config.ts` and `infra/access.tf`), so
 * by the time this code runs the visitor is already authenticated — but the browser has no
 * trustworthy copy of _who_ they are. This store calls `/api/me` to obtain the Worker's verified
 * view of the identity, which is the only version worth displaying.
 *
 * The value is used for more than a header label: the message pane compares each message's author
 * against it to decide which messages are the reader's own. That comparison is presentation only.
 * Authorship itself is decided server-side and is not something the client could influence by
 * reporting a different identity here — at worst a wrong value would mis-style a message bubble.
 *
 * This store is also how the UI notices an expired Access session: once the JWT is no longer valid,
 * `/api/me` answers `401` and `email` stays `null`.
 */
export const useSessionStore = defineStore('session', {
  actions: {
    /**
     * Fetch the verified identity from the Worker.
     *
     * @returns A promise fulfilled after `email` and `loading` are updated. A failure is recorded
     *   in `error` rather than thrown, because the workspace is still usable while the identity
     *   indicator is unavailable.
     */
    async load(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const identity = await requestJson<{ email: string }>('/api/me');
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
