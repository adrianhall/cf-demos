'use client';

import { useEffect, useState } from 'react';
import { useCatalogStore } from './use-catalog';

/**
 * The Cloudflare Access session as the banner presents it.
 */
export interface SessionState {
  /**
   * Verified email address, or `null` while loading or when it could not be determined.
   */
  email: string | null;
  /**
   * Whether the identity lookup is still in flight.
   */
  loading: boolean;
  /**
   * Whether the Access session is known to have expired, so the banner should offer a way back.
   */
  expired: boolean;
}

/**
 * Fetch the Worker's verified view of the current Cloudflare Access identity.
 *
 * Deliberately reports the _server's_ view rather than anything the browser believes: Access gates
 * the hostname at the edge, so the client never sees the JWT and has no trustworthy copy of the
 * identity of its own (UISPEC §4, §10). See `src/worker/routes/me.ts`.
 *
 * @param signal Abort signal, so a lookup outliving the component is dropped rather than warned
 *   about.
 * @returns The verified email address, or `null` when the identity could not be determined, and
 *   whether the failure was specifically an expired session.
 */
async function fetchIdentity(
  signal: AbortSignal
): Promise<{ email: string | null; expired: boolean }> {
  try {
    const response = await fetch('/api/me', { signal });
    if (response.status === 401 || response.status === 403) {
      return { email: null, expired: true };
    }
    if (!response.ok) {
      return { email: null, expired: false };
    }

    const identity = (await response.json()) as { email: string };
    return { email: identity.email, expired: false };
  } catch {
    // Includes the abort case. The component is unmounting or superseded, and the caller discards
    // the result either way, so distinguishing it would change nothing.
    return { email: null, expired: false };
  }
}

/**
 * Track the signed-in Cloudflare Access identity and whether its session is still valid.
 *
 * This hook also owns the "session expired" state for the whole explorer. It registers itself with
 * the catalog store, so any request that meets a `401` reports here and the banner reacts once,
 * rather than each surface growing its own sign-in prompt (UISPEC §9.4, §10).
 *
 * A failed lookup is recorded rather than thrown: the explorer is perfectly usable while the
 * identity indicator is blank, and the dataset is identical for every caller, so not knowing who is
 * signed in withholds nothing.
 *
 * @returns The current session state.
 */
export function useSession(): SessionState {
  const catalog = useCatalogStore();
  const [state, setState] = useState<SessionState>({
    email: null,
    loading: true,
    expired: false
  });

  useEffect(() => {
    const controller = new AbortController();

    void fetchIdentity(controller.signal).then(({ email, expired }) => {
      if (!controller.signal.aborted) {
        setState({ email, loading: false, expired });
      }
    });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    catalog.setSessionExpiredHandler(() => {
      setState((previous) =>
        previous.expired ? previous : { email: null, loading: false, expired: true }
      );
    });
  }, [catalog]);

  return state;
}
