# AI Model Playground

A multi-model AI chat playground based on Cloudflare Workers, Workers AI, and Cloudflare Access.

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches and how it works, and [`DEMO.md`](./DEMO.md) for a presenter's demo script.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare account with a zone that can host `<DEMO_NAME>.<DEMO_DOMAIN>` (default `ai-chat.cfapps.uk`) and no conflicting CNAME on that hostname.
- A Cloudflare Zero Trust team with at least one enabled identity provider (any provider works — this demo does not restrict which one).
- A Cloudflare API token scoped to the target account and zone with:
  - Entire Account > Developer Platform > Workers Scripts: Edit
  - Entire Account > Developer Platform > Workers AI: Edit — required only for local development, since the `AI` binding has no local simulator and `vite dev`/`vitest` open a real, credentialed session against the account. Deploying the Worker itself needs only Workers Scripts: Edit.
  - Entire Account > Cloudflare One / Zero Trust > Access: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Identity Providers: Read
  - `<your-domain>` > DNS & Zones > DNS: Write

Use a remote, encrypted Terraform state backend for shared or production operation. Local state files are gitignored and must not be committed.

## Environment Configuration

```sh
cd demos/ai-chat
cp .env.example .env
```

Set every value in `.env`:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the permissions listed above. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker and Access application, and that Workers AI inference runs against. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `DEMO_DOMAIN`. |
| `DEMO_DOMAIN` | Zone hostname the demo is deployed under, e.g. `cfapps.uk`. |
| `DEMO_NAME` | Worker name and hostname label, `ai-chat`, producing `ai-chat.cfapps.uk`. |
| `CLOUDFLARE_TEAM_DOMAIN` | Access team domain without `https://`, e.g. `example.cloudflareaccess.com`. |

Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated binding types (`worker-configuration.d.ts`).

## Local Development

```sh
npm install
npm start
```

`npm start` generates a local `wrangler.jsonc` from the committed placeholder values in `infra/local-outputs.json`, builds Worker binding types, builds, and starts `vite dev`. No Terraform state is required. Because the `AI` binding has no local simulator, `vite dev` performs real inference against real Workers AI using the credentials in `.env` — see `EXPLAIN-DEMO.md` for why.

The development-only Access plugin offers two selectable identities, matching `.env.example` conventions: `alice@example.com` and `bob@example.com`. An always-visible **Sign out** control uses `/cdn-cgi/access/logout`, useful for recovering from having signed in as the wrong identity.

## Testing

```sh
npm test              # all Vitest projects (worker, client, integration)
npm run test:unit     # worker + client projects only
npm run test:worker
npm run test:client
npm run test:integration
npm run test:coverage
npm run build
npm run check          # format, lint, type check, Terraform fmt/validate
```

## Deployment

```sh
cd demos/ai-chat
cp .env.example .env   # fill in real values
npm run deploy
```

`npm run deploy` runs `deploy:infra` (Terraform `init` then `apply -auto-approve`, reading configuration from `.env`) followed by `deploy:worker` (`vite build && wrangler deploy`). Before building, the `predeploy:worker` hook regenerates `wrangler.jsonc` from the live Terraform outputs (`generate-wrangler -cf --terraform infra`) and regenerates binding types (`generate-wrangler-types`).

### Post-Deploy Verification

1. Open `https://<DEMO_NAME>.<DEMO_DOMAIN>` (default `https://ai-chat.cfapps.uk`) and sign in through Cloudflare Access.
2. Confirm the header shows your verified identity and an unconditional **Sign out** control.
3. Leave the model selector on its default (Granite 4.0 H Micro), type a prompt, and submit.
4. Confirm the answer streams token by token and ends with a latency/token-usage footer.
5. In **Workers & Pages** > `<DEMO_NAME>` > **Logs**, confirm `ai_prompt_submitted`, `ai_first_token`, and `ai_stream_completed` events appear, correlated by `requestId`, with no prompt or completion text in any field.

See `DEMO.md` for the full presenter walkthrough.

## Provisioned Resources

- Worker (`<DEMO_NAME>`) serving the Vue SPA as static assets and a Hono API.
- `AI` binding (Workers AI) — an account capability reached through a binding; Terraform creates no resource for it.
- Custom domain `<DEMO_NAME>.<DEMO_DOMAIN>`.
- One Cloudflare Access self-hosted application backed by an `allow` policy covering the whole hostname (fully authenticated — there is no public bypass application).
- Workers Logs (100% sampling) and traces (10% sampling).

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| `terraform apply` fails with error `100124` attaching the custom domain | Expected on a truly fresh Worker before the bootstrap deployment exists; re-run `npm run deploy` — the inert bootstrap version/deployment satisfies the required ordering. |
| `wrangler.jsonc` already exists and looks wrong | Delete it and re-run the relevant generation step: `npm run generate:wrangler:local` for local development, or `npm run generate:wrangler` after a real `terraform apply`. |
| Access sign-in is denied | Confirm the target Zero Trust organization has an enabled identity provider. The deployed application accepts any available provider. |
| `vite dev`/`vitest` hangs or asks for interactive Cloudflare login | Confirm `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are set in `.env` for `vite dev`. Integration tests should never need this, since `remoteBindings: false` disables it for that project specifically. |
| Local dev fails to get a response, or `npm test` demands credentials | The `AI` binding has no local simulator — see `EXPLAIN-DEMO.md`. Confirm the API token has `Workers AI: Edit` and `.env` is populated; for tests, confirm `remoteBindings: false` is set in `tests/integration/vitest.config.ts`. |
| `npm run build` fails without `.env` | It should not — `vite build` never opens a remote-binding session. If it does, check for an accidental import of `@adrianhall/cloudflare-toolkit/vite` from Worker code. |
| A response ends abruptly with a `400` from Workers AI mentioning `temperature` | A catalog entry has a tighter real bound than its shared input type suggests. Re-run a streaming spike for that model and correct its descriptor in `src/models.ts` — see `EXPLAIN-DEMO.md`. |
| The composer shows "Your session expired" mid-conversation | Expected: the Access session lapsed between turns. Reload and sign in again — this does not indicate a bug. |

## Teardown

```sh
cd demos/ai-chat
npm run teardown
```

`terraform destroy` removes the Worker, the custom domain, and the Access application/policy — no named or billable resources are left behind. Workers AI provisions nothing, so there is no product-specific cleanup step for it. `postteardown` removes the generated `wrangler.jsonc` and `worker-configuration.d.ts`.
