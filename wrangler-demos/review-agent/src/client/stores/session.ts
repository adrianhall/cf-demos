import { defineStore } from "pinia";
import { computed, shallowRef } from "vue";

/** Response returned by `GET /api/me` (`../../worker/routes/me.ts`). */
interface IdentityResponse {
  /** Stable email address from the verified Cloudflare Access identity. */
  email: string;
}

/** Read a safe error message from a failed API response's RFC 9457 problem details body. */
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
 * The verified Cloudflare Access identity for the current browser session (docs/07-PR-REVIEW-
 * AGENT.md, "API And Routing": `GET /api/me`) -- mirrors `demos/agentic-ai-chat`'s own
 * `useSessionStore`, minus its `isAdmin` field: this demo has no per-user authorization at all
 * ("every authenticated identity can see every past run" -- docs/07-PR-REVIEW-AGENT.md, "Out Of
 * Scope"), so there is no administrator role to track here.
 */
export const useSessionStore = defineStore("session", () => {
  const email = shallowRef<string | null>(null);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);
  const isAuthenticated = computed(() => email.value !== null);

  /** Fetch the verified identity from the Worker -- never trusts client-provided data, since
   * Cloudflare Access itself (not this store) is the actual security boundary. */
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
