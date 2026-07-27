# Media Drop Demonstration

Media Drop introduces Cloudflare R2 alongside Workers, D1, Static Assets, and Cloudflare Access. The completed demo will keep media bytes in R2 and metadata in D1, while serving private drafts only through an authorized Worker.

## Current Phase

Phase 1 provisions the independent Cloudflare infrastructure. Phase 2 demonstrates optional authentication on one hostname: the public library remains reachable without signing in, while `/studio` is gated by Cloudflare Access for any authenticated user.

## Demonstration Steps

1. Open `https://media.cfapps.uk/` anonymously and confirm the public library shell loads.
2. Navigate to `/studio` and authenticate with Cloudflare Access.
3. Use the visible **Log out** control to return to the Access login flow and select a different creator identity.

## Observability

Terraform enables Workers Logs and trace sampling. The upload, publish, download, and delete events are implemented in Phase 3 and can then be found by their `media_*` event names in Workers Logs.
