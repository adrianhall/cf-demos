import { defineStore } from "pinia";

/**
 * Client-side authorization check backing `AdminView`'s "not allowed" state.
 *
 * `/admin` itself is served directly by the `ASSETS` binding and gated by Cloudflare Access at
 * the edge (see `wrangler.jsonc.tpl` and `infra/main.tf`), not by this Worker — so the SPA calls
 * `/api/me` after mounting to confirm the verified identity is actually this demo's configured
 * administrator. `/api/me` itself is protected by both `cloudflareAccess` and `requireAdmin`
 * (`src/worker/middleware/require-admin.ts`), so a `403`/`401` here means either no valid
 * Cloudflare Access identity was presented, or a valid identity from the Cloudflare Access team
 * that is not `ADMIN_EMAIL` — both render the same "not allowed" outcome to the administrator.
 */
export const useSessionStore = defineStore("session", {
  actions: {
    /** Call `/api/me` once and record whether the current identity is the administrator. */
    async check(): Promise<void> {
      this.checking = true;
      try {
        const response = await fetch("/api/me");
        if (!response.ok) {
          this.authorized = false;
          return;
        }
        const body = (await response.json()) as { email: string };
        this.email = body.email;
        this.authorized = true;
      } catch {
        this.authorized = false;
      } finally {
        this.checking = false;
      }
    },
  },
  state: () => ({
    /** Verified administrator email once {@link authorized} is `true`. */
    email: "",
    /** `null` until {@link check} first resolves; `true`/`false` afterward. */
    authorized: null as boolean | null,
    /** Whether a {@link check} request is currently pending. */
    checking: false,
  }),
});
