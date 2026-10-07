import { useEffect, useState } from 'react';

/**
 * Response returned by `GET /api/me`.
 */
interface IdentityResponse {
  /**
   * Verified Cloudflare Access identity email.
   */
  email: string;
  /**
   * Whether this identity matches the operator-configured `ADMIN_EMAIL`.
   */
  isAdmin: boolean;
}

/**
 * Cloudflare Access identity state for the current browser session.
 */
export interface IdentityState {
  /**
   * Verified email once loaded, or `null` before the request resolves and after a failure.
   */
  email: string | null;
  /**
   * Whether the verified identity is this demo's configured administrator.
   *
   * Presentational only. The server decides this, and every administrative route re-checks the
   * verified identity itself, so a browser that set this to `true` gains nothing.
   */
  isAdmin: boolean;
  /**
   * Whether the identity request is still in flight.
   */
  loading: boolean;
  /**
   * A safe, user-facing message when the identity request fails, or `null` otherwise.
   *
   * Whether this is worth showing depends on where it happened: on the Access-gated subtree a
   * failure is a real fault, while on a public page it just means the visitor is anonymous. The
   * header decides, not this hook.
   */
  error: string | null;
}

/**
 * Reads a safe, user-facing message from a failed API response.
 *
 * Prefers the RFC 9457 `detail` member the Worker's error handler emits, since that string was
 * written to be shown. Falls back to the status code rather than inventing prose, and never
 * surfaces a response body that is not a problem document.
 *
 * @param response Failed response.
 * @returns A message safe to render.
 */
async function responseMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body === 'object'
    && body !== null
    && 'detail' in body
    && typeof body.detail === 'string'
  ) {
    return body.detail;
  }
  return `Request failed with status ${response.status}.`;
}

/**
 * Fetches the verified Cloudflare Access identity from `GET /api/me` once per mount.
 *
 * The identity always comes from the server. Nothing here reads a cookie, decodes a JWT, or trusts
 * a value the page could have set: the browser's question is "who does the server say I am?", and
 * `/api/me` is the only answer.
 *
 * A failure is reported rather than retried. The endpoint requires Access, so on a public page the
 * common failure is a `401` meaning "not signed in" — an expected state, not a transient fault
 * worth retrying — and the calling view distinguishes the two through its own Access posture.
 *
 * @returns The current identity state, refreshed once per mount.
 */
export function useIdentity(): IdentityState {
  const [state, setState] = useState<IdentityState>({
    email: null,
    error: null,
    isAdmin: false,
    loading: true
  });

  useEffect(() => {
    let cancelled = false;

    /**
     * Resolves the identity and commits it to state, unless the component unmounted first.
     *
     * @returns A promise fulfilled once the state has been committed or the result discarded.
     */
    async function load(): Promise<void> {
      try {
        const response = await fetch('/api/me');
        if (!response.ok) {
          throw new Error(await responseMessage(response));
        }
        const identity = (await response.json()) as IdentityResponse;
        if (!cancelled) {
          setState({
            email: identity.email,
            error: null,
            isAdmin: identity.isAdmin,
            loading: false
          });
        }
      } catch (cause) {
        if (!cancelled) {
          setState({
            email: null,
            error:
              cause instanceof Error
                ? cause.message
                : 'Could not verify your Cloudflare Access identity.',
            isAdmin: false,
            loading: false
          });
        }
      }
    }

    void load();

    // Guards against committing state after unmount, which would both warn and — more importantly
    // for a page the visitor has already navigated away from — resolve an identity into a tree that
    // is no longer on screen.
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
