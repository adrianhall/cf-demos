'use client';

import { useEffect, useState } from 'react';
import { getIdentity } from './chat-api';

/**
 * Header element showing the Worker's verified view of the signed-in Cloudflare Access identity.
 *
 * This is a client component, and a deliberately small one: it is the only part of the document
 * shell that needs browser state, so keeping it separate lets `app/layout.tsx` stay a server
 * component. It renders the identity reported by `/api/me` rather than anything the browser
 * believes, because the browser has no trustworthy copy of its own — see
 * `src/worker/routes/me.ts`.
 *
 * A failed lookup renders nothing rather than an error. The visitor is already past Cloudflare
 * Access by the time this runs, so an unavailable identity indicator is cosmetic; the workspace
 * below it reports its own failures.
 *
 * @returns The verified email address, a transient loading label, or nothing.
 */
export function IdentityBadge(): React.JSX.Element | null {
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    /**
     * Fetch the verified identity, ignoring the result if the component unmounted first.
     *
     * @returns A promise fulfilled once the identity state has settled.
     */
    async function load(): Promise<void> {
      const value = await getIdentity();
      if (active) {
        setEmail(value);
        setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  if (email !== null) {
    return <span className="identity">{email}</span>;
  }
  return loading ? <span className="identity">Verifying identity…</span> : null;
}
