# Chat

A channel-based real-time chat workspace based on Cloudflare Workers, Durable Objects, D1, and Cloudflare Access.

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches and how it works, and [`DEMO.md`](./DEMO.md) for a presenter's demo script.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare zone that can host `<DEMO_NAME>.<DEMO_DOMAIN>` (default `chat.cfapps.uk`) with no conflicting CNAME on that hostname.
- A Cloudflare Zero Trust organization with at least one enabled identity provider (any provider works — this demo does not restrict which one).
- A Cloudflare API token scoped to the target account and zone with:
  - Entire Account > Developer Platform > Workers Scripts: Edit
  - Entire Account > Developer Platform > D1: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Identity Providers: Read
  - `<your-domain>` > DNS & Zones > DNS: Write

## Environment Configuration

```sh
cd demos/chat
cp .env.example .env
```

Set every value in `.env`:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the permissions listed above. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker, D1 database, and Access application. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `DEMO_DOMAIN`. |
| `DEMO_DOMAIN` | Zone hostname the demo is deployed under, e.g. `cfapps.uk`. |
| `DEMO_NAME` | Worker name and hostname label, e.g. `chat` for `chat.cfapps.uk`. |
| `CLOUDFLARE_TEAM_DOMAIN` | Access team domain without `https://`, e.g. `example.cloudflareaccess.com`. |

Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated binding types (`worker-configuration.d.ts`).

## Local Development

```sh
npm install
npm start
```

`npm start` generates a local `wrangler.jsonc` from `wrangler.jsonc.tpl` and the committed placeholder values in `infra/local-outputs.json`, generates binding types, applies the D1 migration locally (`db:migrate:local`), builds, and starts `vite dev`. No Terraform state or cloud resources are required — D1 and the `CHAT_ROOM` Durable Object both run against Miniflare's local simulation.

The development-only Access plugin offers two selectable identities matching `.env.example`'s defaults, `alice@example.com` and `bob@example.com` — enough to run the two-user flow from one machine using two browser windows (or one normal and one private window). The always-visible **Sign out** control uses `/cdn-cgi/access/logout`, emulated locally by the plugin, for switching identities or recovering from signing in as the wrong one.

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
cd demos/chat
npm run deploy
```

`npm run deploy` runs `deploy:infra` (Terraform `init` then `apply -auto-approve`, reading configuration from `.env`) followed by `deploy:worker`. Before building, the `predeploy:worker` hook regenerates `wrangler.jsonc` from the live Terraform outputs (`generate-wrangler -cf --terraform infra`) and regenerates binding types (`generate-wrangler-types`). `deploy:worker` then applies the D1 migration to the remote database (`db:migrate:remote`) before `vite build && wrangler deploy`. `wrangler deploy` also applies the Durable Object SQLite migration declared in `wrangler.jsonc.tpl` and creates the `CHAT_ROOM` namespace on first deploy.

### Post-Deploy Verification

1. Open two browser windows (or one normal and one private) and sign in as two different identities at `https://<DEMO_NAME>.<DEMO_DOMAIN>` (default `https://chat.cfapps.uk`).
2. In both windows, select the seeded `general` channel.
3. Post a message in one window and confirm it appears immediately in the other, labeled with the sender's identity.
4. In the Cloudflare dashboard under **Workers & Pages** > `<DEMO_NAME>` > **Logs**, confirm a `message_posted` event was recorded for the message.

## Provisioned Resources

- Worker (`<DEMO_NAME>`) serving the Vue chat UI as static assets and a Hono API/WebSocket-upgrade service.
- D1 database `<DEMO_NAME>-db`, bound as `DB`, holding only the shared channel directory.
- `CHAT_ROOM` Durable Object binding (`ChatRoom` class, SQLite-backed), one instance per channel name.
- Custom domain `<DEMO_NAME>.<DEMO_DOMAIN>`.
- A single, fully-authenticated Access application and policy covering the whole hostname — no public bypass.
- Workers Logs (100% sampling) and traces (10% sampling).

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| `terraform apply` fails with error `100124` attaching the custom domain | Expected on a truly fresh Worker before its bootstrap deployment exists; re-run `npm run deploy` — the inert bootstrap version/deployment satisfies the required ordering. |
| Access sign-in is denied | Confirm the target Zero Trust organization has an enabled identity provider; the deployed application accepts any available provider. |
| `wrangler dev`/`vite dev` fails to resolve the `CHAT_ROOM` binding | Confirm `src/worker/index.ts` still re-exports `ChatRoom` from `./chat-room/chat-room` — the `durable_objects` binding in `wrangler.jsonc.tpl` requires a named export with that exact class name from the Worker's main module. |
| A channel never receives messages sent in another window | Confirm both windows selected the *same* channel name — a different name always routes to a different Durable Object by design. |
| Rejoining a removed channel isn't empty | Confirm the removal actually completed (`DELETE /api/channels/:channel` returned `204`); the Durable Object's `destroy()` purges storage before the route deletes the D1 row. |
| `generate:wrangler` fails during deploy | Run `npm run deploy:infra:apply` successfully first; every referenced Terraform output must exist. |

## Teardown

```sh
cd demos/chat
npm run teardown
```

`npm run teardown` runs `terraform destroy -auto-approve`, removing the Worker, custom domain, D1 database, and the Access application/policy, then `postteardown` deletes the locally generated `wrangler.jsonc` and `worker-configuration.d.ts`. No R2-style preteardown step is needed: the `CHAT_ROOM` Durable Object namespace and all channel state are removed automatically when Terraform destroys the Worker. Confirm no `<DEMO_NAME>` Worker, D1 database, or Access application remain in the account before discarding local Terraform state.
