# Architect

A Cloudflare architecture diagram editor based on Cloudflare Workers, Static Assets, Cloudflare Access, D1, and Workers KV.

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches and how it works, and [`DEMO.md`](./DEMO.md) for a presenter's demo script.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare account with a zone that can host `<DEMO_NAME>.<DEMO_DOMAIN>` (default `architect.cfapps.uk`) and no conflicting CNAME on that hostname.
- A Cloudflare Zero Trust team with at least one enabled identity provider — any authenticated user from that provider can open the editor.
- A Cloudflare API token scoped to the target account and zone with:
  - Entire Account > Developer Platform > Workers Scripts: Edit
  - Entire Account > Developer Platform > D1: Edit
  - Entire Account > Developer Platform > Workers KV Storage: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Identity Providers: Read
  - `<your-domain>` > DNS & Zones > DNS: Write

## Environment Configuration

```sh
cd demos/architect
cp .env.example .env
```

Set every value in `.env`:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the permissions listed above. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker, D1 database, KV namespace, and Access applications. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `DEMO_DOMAIN`. |
| `DEMO_DOMAIN` | Zone hostname the demo is deployed under, e.g. `cfapps.uk`. |
| `DEMO_NAME` | Worker name and hostname label, e.g. `architect` for `architect.cfapps.uk`. |
| `CLOUDFLARE_TEAM_DOMAIN` | Access team domain without `https://`, e.g. `example.cloudflareaccess.com`. |
| `ADMIN_EMAIL` | The sole identity `GET /api/me` reports as `isAdmin` and that every `/api/admin/*` route accepts. Any other authenticated identity can use the editor but gets `403` from `/api/admin/*` and never sees the admin UI. |

Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated binding types (`worker-configuration.d.ts`).

## Local Development

```sh
npm install
npm start
```

`npm start` generates `wrangler.jsonc` from `wrangler.jsonc.tpl` and the committed local placeholder values in `infra/local-outputs.json`, generates binding types, applies the D1 migration to the local SQLite database (`db:migrate:local`), builds, and starts Vite. No Terraform state or cloud resources are required.

Open the printed local address. `/` is the public landing page, and `/blueprints` is the public blueprint gallery; opening `/app` triggers the local Access dev-login form, which offers `admin@example.com` (matching `infra/local-outputs.json`'s `admin_email`) and `alice@example.com`. Use the visible **Sign out** control in the app shell to switch identities. Local D1 data lives under `.wrangler/` and can be deleted between sessions.

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
cd demos/architect
npm run deploy
```

`npm run deploy` runs `deploy:infra` (Terraform `init` then `apply -auto-approve`, reading configuration from `.env`) followed by `deploy:worker`. Before building, the `predeploy:worker` hook regenerates `wrangler.jsonc` from the live Terraform outputs (`generate-wrangler -cf --terraform infra`) and regenerates binding types (`generate-wrangler-types`). `deploy:worker` then applies the D1 migration to the remote database (`db:migrate:remote`) before building with the deployed Access application's audience tag (`VITE_ACCESS_AUDIENCE`, read from the `access_audience` Terraform output) and deploying the Worker.

Before provisioning for the first time, verify in the Cloudflare dashboard that no Worker, D1 database, KV namespace, or Access application named for `DEMO_NAME` remain from a prior implementation of this demo slot; clean up manually if so.

### Post-Deploy Verification

1. Visit `https://<DEMO_NAME>.<DEMO_DOMAIN>` (default `https://architect.cfapps.uk`) anonymously and confirm the public landing page loads with no sign-in prompt.
2. Select **Open the editor** (`/app`) and confirm Cloudflare Access requests sign-in.
3. Sign in through the configured identity provider and confirm the app shell shows your email.
4. In the Cloudflare dashboard under **Workers & Pages** > `<DEMO_NAME>` > **D1** > `<DEMO_NAME>-db` > **Console**, run `SELECT * FROM users;` and confirm a row exists for the identity you signed in as.
5. Sign in as the identity matching `ADMIN_EMAIL` and confirm the app shell marks it `(administrator)`.
6. From the dashboard, select **+ New Diagram**, choose a blueprint (or a blank canvas), and confirm the editor opens with that diagram's graph.
7. Drag a product from the palette onto the canvas, wait a moment, and confirm the status bar reports a save. Reload the page and confirm the change persisted.
8. In the Cloudflare dashboard's D1 console, run `SELECT id, title, owner_email FROM diagrams;` and confirm the new row exists.
9. In the toolbar, select **Share**, then **Create link**, and copy the shown URL. Open it in a private/incognito window and confirm the diagram renders read-only with no sign-in prompt.
10. Back in the signed-in browser's share dialog, select **Revoke link**, then reload the private/incognito window's share URL and confirm it now reports the link was not found.
11. Select the **Admin** nav link (visible only to the identity matching `ADMIN_EMAIL`) and confirm the user directory table lists every identity that has signed in, with a diagram count per row.
12. In the Cloudflare dashboard's D1 console, run `SELECT id, title, owner_email FROM diagrams;`, copy any diagram's `id`, paste it into the admin view's **Diagram id** field, and select **Open** to confirm its read-only preview renders.
13. Select **Delete diagram**, confirm in the dialog, and confirm the diagram no longer loads for its owner (`404` from `/api/diagrams/:id`).

## Provisioned Resources

- Worker (`<DEMO_NAME>`) serving the React app shell as static assets and a Hono API.
- D1 database `<DEMO_NAME>-db`, bound as `DB` (tables: `diagrams`, `users`, `diagram_shares`).
- Workers KV namespace `<DEMO_NAME>-shares`, bound as `SHARES` — the anonymous share-token
  lookup, keyed by a SHA-256 digest of the token (never the raw token itself).
- Custom domain `<DEMO_NAME>.<DEMO_DOMAIN>`.
- Access application + bypass policy covering the whole hostname (the public landing page,
  `/blueprints`, and the read-only share viewer at `/s/:token`).
- Access application + allow policy for any authenticated user, scoped to `/app*`, `/api/me`,
  `/api/diagrams*`, and `/api/admin*` — deliberately narrower than `/api/*` so the public
  `/api/share/*` resolver stays covered by the bypass application above instead. Admin
  authorization within `/api/admin*` is a further, independent Worker-side check against
  `ADMIN_EMAIL` (see `EXPLAIN-DEMO.md`), not a separate Access policy.
- Workers Logs (100% sampling) and traces (10% sampling).

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| `/app` is public | Confirm the `app` Access application lists `/app*`, `/api/me`, `/api/diagrams*`, and `/api/admin*` destinations, then re-run `npm run deploy`. |
| Local sign-in loops or shows the wrong identity | Visit `/cdn-cgi/access/logout` and choose a different dev identity. |
| `401` from `/api/me` | Sign in through Access at `https://<DEMO_NAME>.<DEMO_DOMAIN>/app`; every `/api/*` route except `/api/share/*` requires a verified Access identity. |
| `isAdmin` is always `false`, or `/api/admin/*` always returns `403` | Confirm the signed-in identity's email exactly matches `ADMIN_EMAIL` in `.env`, then re-run `npm run deploy`. |
| The **Admin** nav link is missing | It only renders for the identity matching `ADMIN_EMAIL`; confirm `GET /api/me` reports `isAdmin: true` for the signed-in identity. |
| The share dialog can't show a link that's already active | Expected: the server only ever returns a share's raw URL once, at creation. Select **Generate new link** to mint (and reveal) a fresh one, which revokes the old one. |
| `generate:wrangler` fails during deploy | Run `npm run deploy:infra:apply` successfully first; every referenced Terraform output must exist. |
| D1 migration fails during deploy | Confirm Terraform apply completed (the D1 database must exist) before `db:migrate:remote` runs; re-run `npm run deploy`. |

## Teardown

```sh
cd demos/architect
npm run teardown
```

`npm run teardown` runs `terraform destroy -auto-approve`, removing the Worker, D1 database, KV namespace, custom domain, and both Access applications/policies, then deletes the locally generated `wrangler.jsonc` and `worker-configuration.d.ts`. Confirm no `<DEMO_NAME>` Worker, D1 database, KV namespace, or Access applications remain in the account before discarding local Terraform state.
