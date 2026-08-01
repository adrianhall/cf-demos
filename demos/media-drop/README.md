# Media Drop

A public media library with an authenticated creator studio, based on Cloudflare Workers, D1, R2, and Cloudflare Access.

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches and how it works, and [`DEMO.md`](./DEMO.md) for a presenter's demo script.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare account with a zone that can host `<DEMO_NAME>.<DEMO_DOMAIN>` (default `media.cfapps.uk`) and no conflicting CNAME on that hostname.
- A Cloudflare Zero Trust team with an identity provider that can authenticate creators.
- A Cloudflare API token scoped to the target account and zone with:
  - Entire Account > Developer Platform > Workers Scripts: Edit
  - Entire Account > Developer Platform > D1: Edit
  - Entire Account > Developer Platform > Workers R2 Storage: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Identity Providers: Read
  - `<your-domain>` > DNS & Zones > DNS: Write

## Environment Configuration

```sh
cd demos/media-drop
cp .env.example .env
```

Set every value in `.env`:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the permissions listed above. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker, D1 database, R2 bucket, and Access applications. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `DEMO_DOMAIN`. |
| `DEMO_DOMAIN` | Zone hostname the demo is deployed under, e.g. `cfapps.uk`. |
| `DEMO_NAME` | Worker name and hostname label, e.g. `media` for `media.cfapps.uk`. |
| `CLOUDFLARE_TEAM_DOMAIN` | Access team domain without `https://`, e.g. `example.cloudflareaccess.com`. |

No `ADMIN_EMAIL` is required: any authenticated user is a valid creator. Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated binding types (`worker-configuration.d.ts`).

## Local Development

```sh
npm install
npm start
```

`prestart` generates an ignored local `wrangler.jsonc` from `wrangler.jsonc.tpl` and the committed placeholder values in `infra/local-outputs.json`, then generates binding types. `npm start` then applies D1 migrations locally (`db:migrate:local`) before starting Vite. No Terraform state or cloud resources are required.

Open `http://localhost:5173/` for the public library and `http://localhost:5173/studio` for the studio; the local Access emulator offers selectable dev identities so signing in takes one click. Use the visible logout control at `/studio` to switch identities. Local D1 rows and R2 objects live under the ignored `.wrangler/` directory; delete it to reset local demo data.

## Testing

```sh
npm run check          # format, lint, type check, Terraform fmt/validate
npm run test:unit      # Worker and client unit projects
npm run test:integration
npm run test:coverage
npm run build
```

## Deployment

```sh
cd demos/media-drop
npm run deploy
```

`npm run deploy` runs `deploy:infra` (Terraform `init` then `apply -auto-approve`, reading configuration from `.env`) followed by `deploy:worker`. Before building, the `predeploy:worker` hook regenerates `wrangler.jsonc` from the live Terraform outputs (`generate-wrangler -cf --terraform infra`) and regenerates binding types (`generate-wrangler-types`). `deploy:worker` then applies D1 migrations against the remote database (`db:migrate:remote`, `CI=1 wrangler d1 migrations apply DB --remote`), builds the Vue application, and deploys the Worker.

### Post-Deploy Verification

1. Open `https://<DEMO_NAME>.<DEMO_DOMAIN>/` (default `https://media.cfapps.uk/`) anonymously and confirm the public library loads with no sign-in prompt.
2. Open `/studio` and confirm Cloudflare Access requests sign-in.
3. Sign in and upload a small image, audio file, or short video with a title. Confirm it appears under **Drafts**.
4. Publish it and confirm it now appears in the public library and can stream or download.
5. Delete it from the studio and confirm it no longer appears in the library.
6. In the Cloudflare dashboard under **Workers & Pages** > `<DEMO_NAME>` > **Logs**, confirm `media_uploaded`, `media_published`, and `media_deleted` events were recorded.

## Provisioned Resources

- Worker (`<DEMO_NAME>`) serving the Vue library/studio UI as static assets and a Hono API.
- D1 database `<DEMO_NAME>-db`, bound as `DB`.
- R2 bucket `<DEMO_NAME>-store`, bound as `MEDIA`.
- Custom domain `<DEMO_NAME>.<DEMO_DOMAIN>`.
- Access application + bypass policy covering the whole hostname (the public library).
- Access application + allow policy for any authenticated user, scoped to `/studio*` and `/api/studio*`.
- Workers Logs (100% sampling) and traces (10% sampling).

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| `/studio` is public | Confirm the studio Access application lists both `/studio*` and `/api/studio*` destinations, then re-run `npm run deploy`. |
| Local sign-in loops or shows the wrong identity | Visit `/cdn-cgi/access/logout` and choose a different dev identity. |
| `401`/`403` from `/api/studio/*` | Confirm you are signed in through the configured identity provider; any authenticated identity is accepted, so this indicates no valid session. |
| Deployment migration fails | Confirm the API token has `Account: D1 - Edit` and that the generated config binds D1 as `DB`. |
| `generate:wrangler` fails during deploy | Run `npm run deploy:infra:apply` successfully first; every referenced Terraform output must exist. |
| Teardown reports a non-empty R2 bucket | Re-run `npm run teardown`; its `preteardown:r2` step empties the bucket before `terraform destroy`. |

## Teardown

```sh
cd demos/media-drop
npm run teardown
```

R2 rejects destroying a non-empty bucket, so `preteardown` runs `preteardown:r2` (`empty-r2-bucket -t infra --env-file .env --yes`) to empty the Terraform-managed bucket first. `teardown` then runs `terraform destroy -auto-approve`, removing the Worker, D1 database, R2 bucket, custom domain, and both Access applications/policies. `postteardown` deletes the locally generated `wrangler.jsonc` and `worker-configuration.d.ts`. Confirm no `<DEMO_NAME>` Worker, D1 database, R2 bucket, or Access applications remain in the account before discarding local Terraform state.
