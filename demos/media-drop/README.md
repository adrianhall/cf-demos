# Media Drop

Media Drop is a Cloudflare Workers demonstration of public media delivery with an optional authenticated creator studio. Phase 1 provisions the Worker, custom hostname, D1 database, and R2 bucket. Phase 2 adds a public Access bypass application and a more-specific authenticated studio application.

## Prerequisites

- Node.js 24+, npm 11+, Terraform 1.10+, and a Cloudflare zone for `cfapps.uk`.
- Copy `.env.example` to `.env` and provide the Cloudflare account, zone, API token, and Access team domain.

## Architecture

- Terraform owns the Worker registration, `media.cfapps.uk` domain, D1 metadata database, R2 media bucket, and both Access applications.
- Wrangler owns Worker code deployments and will own D1 migrations in Phase 3.
- The hostname-wide bypass application serves the public library. The more-specific `/studio*` and `/api/studio*` Access application requires any authenticated user.
- The shared `src/access-policies.ts` applies the same public/studio boundary in the Worker and Vite local development.

## Local Development

Run `npm install`, then `npm start`. The prestart hook creates a local `wrangler.jsonc` and generated Worker binding types. The development Access login offers two selectable creator identities. Use `/cdn-cgi/access/logout` to switch identities.

## Deployment

Run `npm run deploy`. It initializes and applies Terraform, regenerates `wrangler.jsonc` from Terraform outputs, builds the Vite application, and deploys the Worker. Do not run this without a completed `.env`.

## Verification

Open `https://media.cfapps.uk/` to confirm public access. Open `/studio` to confirm Cloudflare Access requires sign-in. Terraform enables Workers Logs and automatic traces with explicit sampling.

## Teardown

Run `npm run teardown`. Its `preteardown` hook empties the R2 bucket through the dashboard's observed empty-bucket API using the ordinary deployment token from `.env`, then Terraform removes all resources. This endpoint is not yet documented as a public API contract; see `docs/DECISIONS.md`.

## Troubleshooting

- If generated bindings are stale, delete the ignored `wrangler.jsonc` and `worker-configuration.d.ts`, then rerun `npm run check:types`.
- If `/studio` is public, verify the Access application's destinations include both `/studio*` and `/api/studio*` and that the hostname has no conflicting Access application.
