# Architect Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches.

> This script covers Phase 1 (scaffolding and Access) of `docs/09-ARCHITECT.md`: a secure, empty app shell. Later phases add the catalog/editor, sharing, admin, and export/print/dark-mode capabilities this script will grow to cover.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/architect`.
2. Confirm you can authenticate through the configured identity provider as at least two different identities, one of which matches this deployment's `ADMIN_EMAIL`.
3. Open a second browser window or tab to the Cloudflare dashboard at **Zero Trust** > **Access controls** > **Applications**.
4. Open a third browser window or tab to the Cloudflare dashboard's **D1** section, ready to open the `architect-db` database's console.
5. Sign out of, or use a private/incognito window for, the demo hostname so the first step shows the unauthenticated experience.

## Presentation Flow

1. In the signed-out/incognito browser, open `https://architect.cfapps.uk/`. Show the public landing page loads with no Access challenge.
2. Switch to the dashboard tab. Open **Zero Trust** > **Access controls** > **Applications** and show the two applications for this demo: a `bypass` application for the whole hostname, and an `allow` application scoped to `/app*` and `/api/*` destinations only.
3. Back in the browser, select **Open the editor**. Show that Cloudflare Access now intercepts the request with its login screen before the app shell renders.
4. Sign in as a non-administrator identity (for example `alice@example.com`). Show the app shell displays that email with no `(administrator)` marker.
5. Switch to the D1 tab. Open the `architect-db` database's console and run:

   ```sql
   SELECT email, display_name, first_seen_at, last_seen_at FROM users;
   ```

   Point out the row for the identity you just signed in as, and that `display_name` is `NULL` — Cloudflare Access's verified identity exposes only an email, not a display name.
6. Back in the browser, use the always-visible **Sign out** control.
7. Sign in as the identity matching this deployment's `ADMIN_EMAIL`. Show the app shell now displays `(administrator)` next to that email.
8. Re-run the D1 query from step 5 and show both identities' rows in the same `users` table, each upserted independently.

## Expected Results

- Unauthenticated visitors see the public landing page at `/`; opening `/app` or calling `/api/me` unauthenticated redirects to (or returns `401` for) Cloudflare Access sign-in.
- Every signed-in identity sees its own email in the app shell; only the identity matching `ADMIN_EMAIL` sees the `(administrator)` marker.
- The `users` table in D1 gains one row per distinct identity that has ever signed in, with `last_seen_at` refreshed on every subsequent visit.

## Where To Observe State

- **Worker logs:** Workers & Pages > `architect` > Logs.
- **Traces:** Workers & Pages > `architect` > Observability > Traces (10% sampling).
- **D1 data:** D1 > `architect-db` > Console; query the `users` table as shown above.
- **Access applications:** Zero Trust > Access controls > Applications > `architect public` and `architect app`.

Run `npm run teardown` after the presentation; see README.md for details.
