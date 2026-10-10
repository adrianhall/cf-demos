# URL Shortener

A short-link management admin app and public redirect service based on Cloudflare Workers, Workers KV, and Cloudflare Access.

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches and how it works, and [`DEMO.md`](./DEMO.md) for a presenter's demo script.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare account with a zone that can host `<DEMO_NAME>.<DEMO_DOMAIN>` (default `link.cfapps.uk`) and no conflicting CNAME on that hostname.
- A Cloudflare Zero Trust team with an identity provider that can authenticate the configured `ADMIN_EMAIL`.
- A Cloudflare API token scoped to the target account and zone with:
  - Entire Account > Developer Platform > Workers Scripts: Edit
  - Entire Account > Developer Platform > Workers KV Storage: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Identity Providers: Read
  - `<your-domain>` > DNS & Zones > DNS: Write

## Environment Configuration

```sh
cd demos/url-shortener
cp .env.example .env
```

Set every value in `.env`:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the permissions listed above. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker, KV namespace, and Access applications. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `DEMO_DOMAIN`. |
| `DEMO_DOMAIN` | Zone hostname the demo is deployed under, e.g. `cfapps.uk`. |
| `DEMO_NAME` | Worker name and hostname label, e.g. `link` for `link.cfapps.uk`. |
| `CLOUDFLARE_TEAM_DOMAIN` | Access team domain without `https://`, e.g. `example.cloudflareaccess.com`. |
| `ADMIN_EMAIL` | The only identity allowed to manage short links. |

Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated binding types (`worker-configuration.d.ts`).

## Local Development

```sh
npm install
npm start
```

`npm start` builds and serves the Worker and admin UI locally against `wrangler.jsonc`, generated from `wrangler.jsonc.tpl` and the committed local placeholder values in `infra/local-outputs.json`. No Terraform state or cloud resources are required. Open `http://localhost:5173/admin` and sign in using the local Access dev-login form. Local KV data lives under `.wrangler/` and can be deleted between sessions.

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
cd demos/url-shortener
npm run deploy
```

`npm run deploy` runs `deploy:infra` (Terraform `init` then `apply -auto-approve`, reading configuration from `.env`) followed by `deploy:worker` (`vite build && wrangler deploy`). Before building, the `predeploy:worker` hook regenerates `wrangler.jsonc` from the live Terraform outputs (`generate-wrangler -cf --terraform infra`) and regenerates binding types (`generate-wrangler-types`).

### Post-Deploy Verification

1. Visit `https://<DEMO_NAME>.<DEMO_DOMAIN>/admin` (default `https://link.cfapps.uk/admin`) and authenticate as `ADMIN_EMAIL`.
2. Create a short link to any HTTPS URL.
3. Open the generated `/l/<code>` URL in a new tab and confirm it redirects to the destination.
4. In the Cloudflare dashboard under **Workers & Pages** > `<DEMO_NAME>` > **Logs**, confirm a `short_link_used` event was recorded for the request.

## Provisioned Resources

- Worker (`<DEMO_NAME>`) serving the Vue admin UI as static assets and a Hono API/redirect service.
- Workers KV namespace `<DEMO_NAME>-links`, bound as `LINKS`.
- Custom domain `<DEMO_NAME>.<DEMO_DOMAIN>`.
- Access application + bypass policy covering the whole hostname.
- Access application + allow policy scoped to `/admin*`, `/api/links*`, and `/api/me*`, restricted to `ADMIN_EMAIL`.
- Workers Logs (100% sampling) and traces (10% sampling).

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| Access denies `/admin` | Confirm `ADMIN_EMAIL`, `CLOUDFLARE_TEAM_DOMAIN`, and the configured identity provider, then re-run `npm run deploy`. |
| `403` from `/api/links` or `/api/me` | The signed-in identity does not match `ADMIN_EMAIL`. Sign in as the configured administrator. |
| Short URL briefly returns `404` or an old destination | Workers KV writes can take up to ~60 seconds to propagate outside the location where they were made. Retry from the same location or wait, then retry. |
| Domain fails to provision | Remove the conflicting DNS record and confirm the supplied zone ID owns `DEMO_DOMAIN`. |
| `generate:wrangler` fails during deploy | Run `npm run deploy:infra:apply` successfully first; every referenced Terraform output must exist. |
| No `short_link_used` log entries | Confirm you are viewing the Terraform-created Worker (`<DEMO_NAME>`), not a stale or differently named service. |

## Teardown

```sh
cd demos/url-shortener
npm run teardown
```

`npm run teardown` runs `terraform destroy -auto-approve`, removing the Worker, Workers KV namespace, custom domain, and both Access applications/policies, then deletes the locally generated `wrangler.jsonc` and `worker-configuration.d.ts`. Confirm no `<DEMO_NAME>` Worker, KV namespace, or Access applications remain in the account before discarding local Terraform state.
