# Agentic Chat Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches. This checkout implements Phase 1 (Scaffolding) only — there is no chat feature to demonstrate yet, only the authenticated shell and D1 user directory the rest of `docs/06-AGENTIC-CHAT.md`'s phases build on.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/agentic-ai-chat`.
2. Confirm you can authenticate through the configured identity provider as at least two different identities: one matching this deployment's `ADMIN_EMAIL`, and one that does not.
3. Open a second browser window or tab to the Cloudflare dashboard at **Zero Trust** > **Access controls** > **Applications**.
4. Open a third browser window or tab to the Cloudflare dashboard's **D1** section, ready to open the `agentic-chat-db` database's console.
5. Sign out of, or use a private/incognito window for, the demo hostname so the first step shows the unauthenticated experience.

## Presentation Flow

1. In the signed-out/incognito browser, open `https://agentic-chat.cfapps.uk/`. Show that Cloudflare Access intercepts the request with its login screen before any part of the app renders.
2. Switch to the dashboard tab. Open **Zero Trust** > **Access controls** > **Applications** and show the single application for this demo, covering the whole hostname with an allow policy that requires authentication from any identity in the configured provider — no public bypass — and note its Audience tag, matched by `VITE_ACCESS_AUDIENCE` in the deployed Worker.
3. Back in the browser, sign in as the identity matching `ADMIN_EMAIL`.
4. Point out the header: the signed-in email and an **Administrator** badge, sourced from `GET /api/me`'s D1-backed `isAdmin` flag, not from Cloudflare Access itself.
5. Switch to the D1 tab. Open the `agentic-chat-db` database's console and run:

   ```sql
   SELECT email, is_admin, created_at FROM users ORDER BY created_at;
   ```

   Point out the administrator's row with `is_admin = 1`.
6. Back in the browser, use the always-visible **Sign out** control.
7. Sign in as the second, non-administrator identity. Point out the header shows no **Administrator** badge.
8. Re-run the D1 query from step 5 and show both identities now have their own row, the second with `is_admin = 0`.
9. Switch to the dashboard tab. Open **Workers & Pages** > `agentic-chat` > **Logs** and show the requests from both sign-ins.
10. Optionally, open **AI Gateway** in the dashboard and show the `agentic-chat` gateway and its two dynamic routes (`agentic-chat-basic`, `agentic-chat-reasoning`), provisioned now but not yet called by any route — a later phase's demo script picks this back up once the chat agent calls them.

## Expected Results

- Unauthenticated visitors to the hostname see the Cloudflare Access login screen, never the app; an unauthenticated `GET /api/me` receives `401`.
- Every sign-in upserts a `users` row; only the identity matching `ADMIN_EMAIL` ever has `is_admin = 1`, regardless of sign-in order.
- The header's **Administrator** badge is driven entirely by that D1 flag, not by Cloudflare Access.

## Where To Observe State

- **Worker logs:** Workers & Pages > `agentic-chat` > Logs.
- **Traces:** Workers & Pages > `agentic-chat` > Observability > Traces (10% sampling).
- **D1 data:** D1 > `agentic-chat-db` > Console; query the `users` table as shown above.
- **Access application:** Zero Trust > Access controls > Applications > `agentic-chat`.
- **AI Gateway:** AI Gateway > `agentic-chat` (gateway and both dynamic routes exist but are unused until a later phase).

Run `npm run teardown` after the presentation; see README.md for details.
