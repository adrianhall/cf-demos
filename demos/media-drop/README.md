# Media Drop

Media Drop is a complete Cloudflare Workers demonstration of an optional-authentication media library. Anyone can browse and download published media; authenticated creators use the Studio to upload private drafts, publish them, and remove them.

## Prerequisites

- Node.js 24+, npm 11+, and Terraform 1.10+.
- An active Cloudflare zone containing `cfapps.uk`.
- A Cloudflare API token with the permissions listed in `.env.example`.
- A configured Cloudflare Access team and identity provider.

Copy `.env.example` to `.env` and provide the account, zone, API token, and Access team-domain values. Do not commit `.env`.

## Architecture

- One Worker serves the Vue static assets and Hono API at `https://media.cfapps.uk`.
- D1 stores metadata only: title, verified owner email, type, byte count, R2 key, publication state, and timestamps.
- R2 stores media bytes only. The bucket is never public; the Worker authorizes every object read.
- `GET /api/library/*` returns only published metadata and content. R2 range and conditional reads support streaming and seeking.
- `/api/studio/*` requires Cloudflare Access. Every D1 query and R2 key lookup is scoped to the verified owner, so creators cannot access each other's media.
- A hostname-wide Access bypass application covers the public library. A more-specific Access application protects `/studio*` and `/api/studio*` for any authenticated user.
- Terraform owns the Worker registration, custom domain, Access applications, D1 database, and R2 bucket. Wrangler owns D1 migrations and Worker code deployments.

## Local Development

```sh
npm install
npm start
```

`prestart` generates an ignored local `wrangler.jsonc` and binding types, applies D1 migrations to local storage, then starts Vite. The local Access emulator offers `creator@example.com` and `another-creator@example.com`; use the visible **Log out** control at `/studio` to switch identities.

Local objects and D1 rows are stored under the ignored `.wrangler/` directory. Delete that directory to reset local demo data.

## Testing And Checks

```sh
npm run test
npm run test:coverage
npm run test:worker
npm run test:client
npm run test:integration
npm run check
terraform -chdir=infra fmt -check
```

The Worker tests cover validation, R2 key/range logic, Access policy ordering, and the R2 teardown helper. Client tests cover upload validation, the public library grid, and Studio media actions. Integration tests run the Worker with Miniflare D1 and R2, apply the real migrations, and cover draft privacy, Access enforcement, owner isolation, publishing, streaming, and deletion of both the R2 object and D1 row.

`npm run check` runs formatting, linting, type checking, and Terraform validation. Terraform validation requires `terraform -chdir=infra init` first.

## Deployment

```sh
npm run deploy
```

The command initializes and applies Terraform, force-generates `wrangler.jsonc` from Terraform outputs, generates binding types, applies D1 migrations remotely with `CI=1`, builds the Vue application, and deploys the Worker. The first Terraform apply creates an inert bootstrap deployment so Cloudflare can attach the custom domain; later Wrangler deployments own all real Worker versions.

Verify the deployment:

1. Open `https://media.cfapps.uk/` anonymously. The library is public.
2. Open `/studio`; Cloudflare Access must request sign-in.
3. Upload a supported image, audio file, or short video. It appears only in the signed-in creator's drafts.
4. Publish it and confirm it appears in the public library and can stream or download.
5. Delete it from Studio and confirm it no longer appears publicly.

## Observability

Terraform enables Workers Logs and automatic tracing with explicit sampling. Workers emits structured informational events after successful actions: `media_uploaded`, `media_published`, `media_downloaded`, and `media_deleted`. Filter Workers Logs by these event names. Logs contain media identifiers and non-sensitive metadata, never Access tokens, object bytes, or authorization headers.

## Troubleshooting

- If local bindings are stale, remove the ignored `wrangler.jsonc` and `worker-configuration.d.ts`, then run `npm run check:types`.
- If local Studio authentication loops, visit `/cdn-cgi/access/logout` and choose an identity again.
- If deployment migration fails, confirm the API token has `Account: D1 - Edit` and that the generated config binds D1 as `DB`.
- If `/studio` is public, confirm the authenticated Access application lists both `/studio*` and `/api/studio*` destinations.
- If teardown reports a non-empty R2 bucket, rerun `npm run teardown`; its preteardown step empties the Terraform-derived bucket before destroy.

## Teardown

```sh
npm run teardown
```

`preteardown` calls `scripts/empty-r2-bucket.js` with the Terraform-derived bucket name. It uses the ordinary deployment token from `.env` to call the dashboard-observed empty-bucket endpoint, because Cloudflare refuses to delete non-empty buckets. The endpoint is undocumented; its rationale and copy guidance live in `docs/DECISIONS.md`. Terraform then destroys the Worker, D1 database, R2 bucket, domain, and Access resources. `postteardown` removes generated Wrangler configuration and binding types.
