# URL Shortener Demo Guide

## Purpose

This demo shows how one Cloudflare Worker can serve a browser-based administration experience, persist redirect configuration in Workers KV, redirect visitors at the edge, and record link use in Workers Logs.

## Cloudflare Capabilities

- **Workers** serves Vue static assets and Hono API/redirect routes from one service.
- **Workers KV** stores each short-link record under a namespaced key.
- **Cloudflare Access** keeps administration private while `/l/:code` remains public.
- **Workers Logs and traces** expose redirect activity and execution data.
- **Custom Domains** serves the demo from `https://link.cfapps.uk`.

## Demonstration Prerequisites

1. Deploy with `npm run deploy` from `demos/url-shortener`.
2. Confirm the presenter can authenticate as `ADMIN_EMAIL`.
3. Prepare a harmless customer HTTPS URL, such as an organization home page.
4. Open Cloudflare Dashboard > Workers & Pages > `link` > Logs in a second browser window.

## Presentation Flow

1. Open `https://link.cfapps.uk/` in a signed-out browser and show that it navigates to the Access-protected `/admin` document before rendering the UI.
2. Explain that Cloudflare Access protects the management page and API, while the public redirect endpoint is intentionally bypassed.
3. Enter the customer URL and select **Create short link**.
4. Point out the generated immutable code and copy/open its `https://link.cfapps.uk/l/<code>` URL.
5. Show the visitor landing at the configured customer destination after a `302` edge redirect.
6. Return to Workers Logs and filter for `short_link_used`.
7. Open the matching informational event and highlight its `code`, `requestId`, and `service` fields.
8. Return to the admin page, edit the destination, and explain that `Cache-Control: no-store` ensures the redirect is evaluated again rather than cached by the browser or edge.
9. Optionally delete the link to demonstrate immediate administrative cleanup, noting that KV propagation may take time between global locations.

## Expected Results

- Unauthenticated visitors to `/` or `/admin` see the Cloudflare Access login or denial experience without seeing the administration UI; unauthenticated `/api/links` requests receive `401`.
- Public `/l/<code>` requests return `302` with the configured `Location` and `Cache-Control: no-store`.
- Every redirect creates an informational structured `short_link_used` event in Workers Logs.
- The log does not contain destination URLs, visitor IP addresses, tokens, or authorization headers.

## Where To Observe State

- **Worker logs:** Workers & Pages > `link` > Logs; filter `message` for `short_link_used`.
- **Traces:** Workers & Pages > `link` > Observability > Traces; trace sampling is 10%.
- **KV data:** Workers KV > `link-links`; values are JSON and keys begin with `link:`.
- **Access policy:** Zero Trust > Access controls > Applications; inspect the public and administrator applications.

## Presenter Notes

Workers KV is eventually consistent. New values are immediately visible locally but can take up to about 60 seconds to appear globally. If a just-created short URL is temporarily unavailable, retry from the presentation location after a brief wait. This is an intentional product characteristic, not a redirect failure.

## Cleanup

Run `npm run teardown` in `demos/url-shortener` after the presentation. It removes every provisioned demo resource.
