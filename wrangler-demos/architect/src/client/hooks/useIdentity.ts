import { useEffect, useState } from "react";

/** Response returned by `GET /api/me`. */
interface IdentityResponse {
  /** Verified Cloudflare Access identity email. */
  email: string;
  /** Whether this identity matches the operator-configured `ADMIN_EMAIL`. */
  isAdmin: boolean;
}

/** Cloudflare Access identity state for the current browser session. */
export interface IdentityState {
  /** Verified email once loaded, `null` before the request resolves or after a failure. */
  email: string | null;
  /** Whether the verified identity is this demo's configured administrator. */
  isAdmin: boolean;
  /** Whether the identity request is still in flight. */
  loading: boolean;
  /** A safe, user-facing message when the identity request fails. */
  error: string | null;
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
 * Fetch the verified Cloudflare Access identity from `GET /api/me` on mount, without relying on
 * client-provided data. Used by the authenticated app shell (and, from Phase 4 on, the admin
 * navigation) to render the signed-in identity and conditionally show admin UI via `isAdmin`.
 *
 * @returns The current identity state, refreshed once per mount.
 */
export function useIdentity(): IdentityState {
  const [state, setState] = useState<IdentityState>({
    email: null,
    error: null,
    isAdmin: false,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch("/api/me");
        if (!response.ok) {
          throw new Error(await responseMessage(response));
        }
        const identity = (await response.json()) as IdentityResponse;
        if (!cancelled) {
          setState({
            email: identity.email,
            error: null,
            isAdmin: identity.isAdmin,
            loading: false,
          });
        }
      } catch (cause) {
        if (!cancelled) {
          setState({
            email: null,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not verify your Cloudflare Access identity.",
            isAdmin: false,
            loading: false,
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
