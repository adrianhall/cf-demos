# Tasks

An authenticated personal todo app based on Cloudflare Workers and D1.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare account with a zone that can host `<DEMO_NAME>.<DEMO_DOMAIN>` (default `tasks.cfapps.uk`) and no conflicting CNAME on that hostname.
- A Cloudflare Zero Trust team with at least one enabled identity provider — any authenticated user from that provider can sign in.
- A Cloudflare API token scoped to the target account and zone with:
  - Entire Account > Developer Platform > Workers Scripts: Edit
  - Entire Account > Developer Platform > D1: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Identity Providers: Read
  - `<your-domain>` > DNS & Zones > DNS: Write

## Environment Configuration

```sh
cd demos/todo-app
cp .env.example .env
```

Set every value in `.env`:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the permissions listed above. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker, D1 database, and Access application. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `DEMO_DOMAIN`. |
| `DEMO_DOMAIN` | Zone hostname the demo is deployed under, e.g. `cfapps.uk`. |
| `DEMO_NAME` | Worker name and hostname label, e.g. `tasks` for `tasks.cfapps.uk`. |
| `CLOUDFLARE_TEAM_DOMAIN` | Access team domain without `https://`, e.g. `example.cloudflareaccess.com`. |

Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated binding types (`worker-configuration.d.ts`).

## Local Development

```sh
npm install
npm start
```

`npm start` generates `wrangler.jsonc` from `wrangler.jsonc.tpl` and the committed local placeholder values in `infra/local-outputs.json`, generates binding types, applies the D1 migration to the local SQLite database (`db:migrate:local`), builds, and starts Vite. No Terraform state or cloud resources are required. Open the printed local address and sign in using the local Access dev-login form, which offers `alice@example.com` and `bob@example.com`. Local D1 data lives under `.wrangler/` and can be deleted between sessions.

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
cd demos/todo-app
npm run deploy
```

`npm run deploy` runs `deploy:infra` (Terraform `init` then `apply -auto-approve`, reading configuration from `.env`) followed by `deploy:worker`. Before building, the `predeploy:worker` hook regenerates `wrangler.jsonc` from the live Terraform outputs (`generate-wrangler -cf --terraform infra`) and regenerates binding types (`generate-wrangler-types`). `deploy:worker` then applies D1 migrations to the remote database (`db:migrate:remote`) before running `vite build && wrangler deploy`.

### Post-Deploy Verification

1. Visit `https://<DEMO_NAME>.<DEMO_DOMAIN>` (default `https://tasks.cfapps.uk`) and authenticate through the configured identity provider.
2. Create a task, mark it complete, then delete it.
3. Sign out using the visible **Sign out** control, sign in as a different identity, and confirm the first task is not visible.
4. In the Cloudflare dashboard under **Workers & Pages** > `<DEMO_NAME>` > **Logs**, confirm a `todo_created` event was recorded for the request.

## Provisioned Resources

- Worker (`<DEMO_NAME>`) serving the Vue todo UI as static assets and a Hono API.
- D1 database `<DEMO_NAME>-db`, bound as `DB`.
- Custom domain `<DEMO_NAME>.<DEMO_DOMAIN>`.
- Access application + allow policy requiring authentication for the whole hostname.
- Workers Logs (100% sampling) and traces (10% sampling).

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| Access denies sign-in | Confirm `CLOUDFLARE_TEAM_DOMAIN` and that an identity provider is enabled in the target Zero Trust organization, then re-run `npm run deploy`. |
| `401` from any `/api/*` route | Sign in through Access at `https://<DEMO_NAME>.<DEMO_DOMAIN>`; every API route requires a verified Access identity. |
| Domain fails to provision | Remove the conflicting DNS record and confirm the supplied zone ID owns `DEMO_DOMAIN`. |
| `generate:wrangler` fails during deploy | Run `npm run deploy:infra:apply` successfully first; every referenced Terraform output must exist. |
| D1 migration fails during deploy | Confirm Terraform apply completed (the D1 database must exist) before `db:migrate:remote` runs; re-run `npm run deploy`. |
| No `todo_created` log entries | Confirm you are viewing the Terraform-created Worker (`<DEMO_NAME>`), not a stale or differently named service. |

## Teardown

```sh
cd demos/todo-app
npm run teardown
```

`npm run teardown` runs `terraform destroy -auto-approve`, removing the Worker, D1 database, custom domain, and Access application/policy, then deletes the locally generated `wrangler.jsonc` and `worker-configuration.d.ts`. Confirm no `<DEMO_NAME>` Worker, D1 database, or Access application remain in the account before discarding local Terraform state.

See `EXPLAIN-DEMO.md` for what this demo teaches and how it works, and `DEMO.md` for a presenter's demo script.
