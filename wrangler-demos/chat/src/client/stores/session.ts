import { defineStore } from "pinia";
import { computed, shallowRef } from "vue";

/** Response returned by the authenticated identity endpoint. */
interface IdentityResponse {
  /** Stable email address from the verified Cloudflare Access identity. */
  email: string;
}

/** Read a safe error message from a failed API response. */
async function responseMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "detail" in body &&
    typeof body.detail === "string"
  ) {
    return body.detail;
  }
  return `Request failed with status ${response.status}.`;
}

/**
 * Cloudflare Access identity state for the current browser session, used to label the header
 * and to distinguish the signed-in participant's own messages in the message pane.
 */
export const useSessionStore = defineStore("session", () => {
  const email = shallowRef<string | null>(null);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);
  const isAuthenticated = computed(() => email.value !== null);

  /** Fetch the verified identity from the Worker without relying on client-provided data. */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetch("/api/me");
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      const identity = (await response.json()) as IdentityResponse;
      email.value = identity.email;
    } catch (cause) {
      email.value = null;
      error.value =
        cause instanceof Error
          ? cause.message
          : "Could not verify your Cloudflare Access identity.";
    } finally {
      loading.value = false;
    }
  }

  return { email, error, isAuthenticated, load, loading };
});
