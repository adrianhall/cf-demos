# URL Shortener Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/url-shortener`.
2. Confirm you can authenticate as `ADMIN_EMAIL` through the configured identity provider.
3. Prepare a harmless HTTPS test URL, such as an organization home page.
4. Open a second browser window or tab to the Cloudflare dashboard at **Zero Trust** > **Access controls** > **Applications**.
5. Sign out of, or use a private/incognito window for, the demo hostname so the first step shows the unauthenticated experience.

## Presentation Flow

1. In the signed-out/incognito browser, open `https://link.cfapps.uk/`. Show that it immediately redirects to `/admin` and presents the Cloudflare Access login screen instead of the admin UI.
2. Switch to the dashboard tab. Open **Zero Trust** > **Access controls** > **Applications** and show the two applications for this demo: the public application (bypass policy, covers the whole hostname) and the administrator application (allow policy, scoped to `/admin*`, `/api/links*`, and `/api/me*`, restricted to `ADMIN_EMAIL`).
3. Back in the browser, sign in as `ADMIN_EMAIL` to reach the admin page.
4. Paste the prepared test URL into the create form and select **Create short link**.
5. Point out the generated immutable code, then copy the resulting `https://link.cfapps.uk/l/<code>` URL.
6. Open that URL in a new tab and show the visitor landing on the configured destination after a `302` redirect.
7. Switch to the dashboard tab. Open **Workers & Pages** > `link` > **Logs**, and locate the matching `short_link_used` event for the redirect you just triggered.
8. Open that log event and point out its `code`, `requestId`, and `service` fields, and that it contains no destination URL, visitor IP, or authorization data.
9. Open **Workers & Pages** > `link` > **Observability** > **Traces** and show the request trace for the same redirect (traces sample at 10%, so refresh or repeat the redirect if none is visible yet).
10. Open **Workers KV** > `link-links` in the dashboard and show the `link:<code>` key holding the link's JSON record.
11. Return to the admin page, edit the link's destination, and save.
12. Re-open the same `/l/<code>` URL and show it now redirects to the updated destination, and mention that `Cache-Control: no-store` is why the browser and edge re-evaluate the redirect instead of serving a cached one.
13. Delete the link from the admin page to show administrative cleanup, and note that other locations may briefly keep serving the old redirect while their cached KV read expires.

## Expected Results

- Unauthenticated visitors to `/` or `/admin` see the Cloudflare Access login/denial screen, never the admin UI; unauthenticated `/api/links` and `/api/me` requests receive `401`.
- Public `/l/<code>` requests return `302` with the configured `Location` and `Cache-Control: no-store`.
- Every redirect produces one informational `short_link_used` event in Workers Logs.
- The log event never contains destination URLs, visitor IP addresses, tokens, or authorization headers.

## Where To Observe State

- **Worker logs:** Workers & Pages > `link` > Logs; filter `message` for `short_link_used`.
- **Traces:** Workers & Pages > `link` > Observability > Traces (10% sampling).
- **KV data:** Workers KV > `link-links`; values are JSON and keys begin with `link:`.
- **Access applications:** Zero Trust > Access controls > Applications; inspect the public and administrator applications and their policies.

Run `npm run teardown` after the presentation; see README.md for details.
