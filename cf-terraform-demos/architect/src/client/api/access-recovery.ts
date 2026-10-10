import { useEffect } from 'react';

/**
 * @file Resumes one browser API request across a Cloudflare Access sign-in navigation. An API
 *   policy deliberately answers an expired Access session with an RFC 9457 `401`, rather than
 *   redirecting the `fetch` to a login page: a JSON caller cannot use the HTML Access sends back,
 *   and WebSocket upgrades cannot follow redirects at all. A **document** navigation to `/app`,
 *   however, is Access-gated and is exactly the supported sign-in flow. This module bridges those
 *   two correct behaviours without turning API policies into HTML redirects. A `fetch` itself
 *   cannot be paused through that document navigation — its JavaScript context is destroyed — so
 *   recovery has three explicit steps:
 *
 *   1. The API wrapper stores one serialisable same-origin JSON request plus the public URL that
 *      started it in `sessionStorage`, then navigates to `/app?resume-api-request=1`.
 *   2. {@link AccessRecoveryPage} runs only after Access has returned the browser to that protected
 *      page, replays the request with the fresh Access cookie, stores its JSON response, and
 *      returns to the original URL.
 *   3. The API wrapper on the reloaded original page consumes that stored response instead of sending
 *      the request a second time. A replayed `401`/other failure is consumed as an error once, so a
 *      bad identity or a changed authorization policy cannot create a redirect loop. It is
 *      intentionally one request, not a durable offline queue: all current mutations are idempotent
 *      enough to replay once, a browser tab has exactly one active human action at a time, and a
 *      queue would have to answer ordering and stale-intent questions this demo does not need.
 */

/**
 * Query flag making the protected `/app` document render {@link AccessRecoveryPage} rather than the
 * ordinary app shell.
 */
export const ACCESS_RECOVERY_QUERY = 'resume-api-request';

/**
 * Session-storage key for the one request waiting for authentication.
 */
const PENDING_REQUEST_KEY = 'architect.pending-api-request';

/**
 * Session-storage key for the replay result returned to the original page.
 */
const RECOVERED_RESPONSE_KEY = 'architect.recovered-api-response';

/**
 * Versioned stored form of an API request.
 */
interface PendingApiRequest {
  /**
   * Storage shape version, rejecting unrelated or old session data safely.
   */
  version: 1;
  /**
   * Same-origin API path, including any query string.
   */
  path: string;
  /**
   * HTTP method the caller intended, defaulting to `GET` when absent.
   */
  method: string;
  /**
   * JSON text body, when the caller supplied one.
   */
  body: string | null;
  /**
   * Page the browser returns to after replaying the request.
   */
  returnTo: string;
}

/**
 * Session-storage form of a completed replay.
 */
interface RecoveredApiResponse {
  /**
   * Storage shape version.
   */
  version: 1;
  /**
   * The request this response belongs to; prevents one action consuming another's answer.
   */
  requestKey: string;
  /**
   * Whether the replay succeeded with a 2xx status.
   */
  ok: boolean;
  /**
   * JSON-serialised object body, or `null` for an empty/non-JSON response. Stored as text because
   * `sessionStorage` itself stores text and because replaying a response must not rely on a shared
   * mutable object surviving the document navigation.
   */
  body: string | null;
}

/**
 * Result an API wrapper can consume after Access returned the browser to its original page.
 */
export interface RecoveredApiResult {
  /**
   * Whether the replay response was successful.
   */
  ok: boolean;
  /**
   * Parsed response object, or `null` when the server supplied no JSON object.
   */
  body: Record<string, unknown> | null;
}

/**
 * Returns a stable key for the part of a request its response can answer.
 *
 * @param path API path including query parameters.
 * @param init Request details supplied by the caller.
 * @returns A string identifying this request for the lifetime of a browser session.
 */
function requestKey(path: string, init?: RequestInit): string {
  return JSON.stringify({
    body: typeof init?.body === 'string' ? init.body : null,
    method: init?.method ?? 'GET',
    path
  });
}

/**
 * Parses a JSON string held in session storage, rejecting malformed or unrelated values.
 *
 * @param value Raw storage value.
 * @returns The parsed object, or `null` when it was missing, malformed or not an object.
 */
function storedObject(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads one recovered response if it belongs to this request, consuming it whether it succeeded or
 * failed so a replay failure cannot cause another Access redirect loop.
 *
 * @param path API path the caller is about to send.
 * @param init Request details the caller is about to send.
 * @returns The replay result, or `null` when this is an ordinary first attempt.
 */
export function takeRecoveredApiResult(
  path: string,
  init?: RequestInit
): RecoveredApiResult | null {
  const recovered = storedObject(sessionStorage.getItem(RECOVERED_RESPONSE_KEY));
  if (
    recovered?.version !== 1
    || recovered.requestKey !== requestKey(path, init)
    || typeof recovered.ok !== 'boolean'
  ) {
    return null;
  }

  sessionStorage.removeItem(RECOVERED_RESPONSE_KEY);
  return {
    body: storedObject(typeof recovered.body === 'string' ? recovered.body : null),
    ok: recovered.ok
  };
}

/**
 * Stages an API request and starts the browser's Access sign-in flow.
 *
 * @param path Same-origin API path that received `401`.
 * @param init Request details to replay after authentication.
 * @returns Nothing. The browser immediately starts a document navigation.
 * @throws {Error} When `sessionStorage` is unavailable. The caller then reports the original
 *   unauthorized response rather than navigating and losing an action it cannot replay safely.
 */
export function beginAccessRecovery(path: string, init?: RequestInit): void {
  const body = init?.body;
  // All client API calls are JSON and therefore strings. Refusing an unknown body is deliberate:
  // serialising a FormData or ReadableStream differently would claim to preserve a request while
  // changing its meaning.
  if (body !== undefined && typeof body !== 'string') {
    throw new Error('Cannot resume a request with a non-JSON body after sign in.');
  }

  const current = new URL(window.location.href);
  const pending: PendingApiRequest = {
    body: body ?? null,
    method: init?.method ?? 'GET',
    path,
    returnTo: `${current.pathname}${current.search}${current.hash}`,
    version: 1
  };
  sessionStorage.setItem(PENDING_REQUEST_KEY, JSON.stringify(pending));

  // `/app` is protected by Access at the edge. It is deliberately a full navigation rather than a
  // client-side route: only a document request gives Access its opportunity to challenge and then
  // return the visitor to this continuation page.
  window.location.assign(`/app?${ACCESS_RECOVERY_QUERY}=1`);
}

/**
 * Validates a pending request read from session storage.
 *
 * @param value Parsed storage value.
 * @returns The request when every field has the expected primitive shape, otherwise `null`.
 */
function pendingRequest(value: Record<string, unknown> | null): PendingApiRequest | null {
  if (
    value?.version !== 1
    || typeof value.path !== 'string'
    || typeof value.method !== 'string'
    || (value.body !== null && typeof value.body !== 'string')
    || typeof value.returnTo !== 'string'
  ) {
    return null;
  }
  // Do not let session storage become an open redirect or a way to replay a cross-origin request.
  if (
    !value.path.startsWith('/api/')
    || !value.returnTo.startsWith('/')
    || value.returnTo.startsWith('//')
  ) {
    return null;
  }
  return {
    body: value.body as string | null,
    method: value.method,
    path: value.path,
    returnTo: value.returnTo,
    version: 1
  };
}

/**
 * Replays the request that triggered a sign-in and returns the browser to its original page.
 *
 * It is exported separately from the component so a focused test can exercise storage and fetch
 * without mounting React.
 *
 * @returns A promise fulfilled after the replay result is stored and navigation is started. When no
 *   valid pending request exists, it returns the browser to `/` without making a request.
 */
export async function resumeAccessRecovery(): Promise<void> {
  const pending = pendingRequest(storedObject(sessionStorage.getItem(PENDING_REQUEST_KEY)));
  sessionStorage.removeItem(PENDING_REQUEST_KEY);

  if (pending === null) {
    window.location.replace('/');
    return;
  }

  let result: RecoveredApiResponse;
  try {
    const response = await fetch(pending.path, {
      body: pending.body ?? undefined,
      headers: { 'Content-Type': 'application/json' },
      method: pending.method
    });
    const decoded: unknown = await response.json().catch(() => null);
    result = {
      body:
        typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
          ? JSON.stringify(decoded)
          : null,
      ok: response.ok,
      requestKey: JSON.stringify({
        body: pending.body,
        method: pending.method,
        path: pending.path
      }),
      version: 1
    };
  } catch {
    // A transport failure must still take the visitor back to their action, where the existing API
    // error path can describe it. Leaving them on a blank recovery page would make recovery worse
    // than the original 401.
    result = {
      body: null,
      ok: false,
      requestKey: JSON.stringify({
        body: pending.body,
        method: pending.method,
        path: pending.path
      }),
      version: 1
    };
  }

  sessionStorage.setItem(RECOVERED_RESPONSE_KEY, JSON.stringify(result));
  window.location.replace(pending.returnTo);
}

/**
 * The tiny protected continuation page rendered at `/app?resume-api-request=1`.
 *
 * @returns No visual UI. The Access challenge has already happened before this bundle runs; this
 *   component's only job is to resume the action and return to the page the person was using.
 */
export function AccessRecoveryPage() {
  useEffect(() => {
    void resumeAccessRecovery();
  }, []);

  return null;
}
