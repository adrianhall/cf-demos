import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * Cloudflare Access identity for the current browser session.
 *
 * The explorer's document is served by the `ASSETS` binding behind an Access application that gates
 * the whole hostname (see `cloudflare.config.ts` and `infra/access.tf`), so by the time this runs
 * the visitor is already authenticated — but the browser never sees the JWT and has no trustworthy
 * copy of _who_ they are. This store asks the Worker, whose answer is the only version worth
 * displaying (UISPEC §4, §10).
 *
 * It also owns the "session expired" state for the whole application. Any part of the UI that meets
 * a `401` reports it here (see `./catalog.ts`), and the banner reacts once, rather than each
 * surface growing its own sign-in prompt.
 *
 * @returns The session store.
 */
export const useSessionStore = defineStore('session', () => {
  const email = ref<string | null>(null);
  const loading = ref(false);
  const expired = ref(false);

  /**
   * Fetch the verified identity from the Worker.
   *
   * A failure is recorded rather than thrown: the explorer is perfectly usable while the identity
   * indicator is blank, and the dataset is identical for every caller, so not knowing who is signed
   * in withholds nothing.
   *
   * @returns A promise fulfilled once the identity has been resolved or the attempt has failed.
   */
  async function load(): Promise<void> {
    loading.value = true;
    try {
      const response = await fetch('/api/me');
      if (response.status === 401 || response.status === 403) {
        expired.value = true;
        email.value = null;
        return;
      }
      if (!response.ok) {
        email.value = null;
        return;
      }

      const identity = (await response.json()) as { email: string };
      email.value = identity.email;
      expired.value = false;
    } catch {
      email.value = null;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Record that the Access session is no longer valid.
   *
   * Called by any surface that meets a `401`, so the prompt to sign in again appears once and in
   * one place, however the expiry was discovered.
   */
  function markExpired(): void {
    expired.value = true;
    email.value = null;
  }

  return { email, loading, expired, load, markExpired };
});
