# Agentic Chat

An authenticated enterprise AI chat agent based on Cloudflare Workers, D1, Cloudflare Access, Durable Objects, the Agents SDK, Workers AI, AI Gateway, and Dynamic Workers.

> This demo ships in phases (see `docs/06-AGENTIC-CHAT.md`), each tagged in git so any two can be diffed. This checkout implements **Phase 1 (Scaffolding)**, **Phase 2 (Core Agentic Chat, US-1)**, **Phase 3 (Chat Sidebar And Management, US-2)**, and **Phase 4 (Governed Model Selection Via Dynamic Routes, US-3)**: a signed-in user can hold a real, streamed, multi-turn conversation with a Durable Object-backed `ChatAgent`, persisted across reloads, manage more than one chat from a sidebar -- creating, switching between, and deleting chats, each auto-titled after its first exchange -- and choose between a "Basic" and a "Reasoning" mode per chat, each backed by a governed AI Gateway dynamic route rather than a client-visible model id. Later phases add voice dictation, cost tracking, tools, skills, and an admin console.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare account with a zone that can host `<DEMO_NAME>.<DEMO_DOMAIN>` (default `agentic-chat.cfapps.uk`) and no conflicting CNAME on that hostname.
- A Cloudflare Zero Trust team with at least one enabled identity provider — any authenticated user from that provider can sign in.
- A Cloudflare API token scoped to the target account and zone with:
  - Entire Account > Developer Platform > Workers Scripts: Edit
  - Entire Account > Developer Platform > D1: Edit
  - Entire Account > Developer Platform > Workers AI: Edit (also required for local development — see Troubleshooting)
  - Entire Account > Developer Platform > AI Gateway: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Identity Providers: Read
  - `<your-domain>` > DNS & Zones > DNS: Write

## Environment Configuration

```sh
cd demos/agentic-ai-chat
cp .env.example .env
```

Set every value in `.env`:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the permissions listed above. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker, D1 database, AI Gateway, and Access application. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `DEMO_DOMAIN`. |
| `DEMO_DOMAIN` | Zone hostname the demo is deployed under, e.g. `cfapps.uk`. |
| `DEMO_NAME` | Worker name, AI Gateway id, and hostname label, e.g. `agentic-chat` for `agentic-chat.cfapps.uk`. |
| `CLOUDFLARE_TEAM_DOMAIN` | Access team domain without `https://`, e.g. `example.cloudflareaccess.com`. |
| `ADMIN_EMAIL` | Identity idempotently promoted to this demo's D1-flagged administrator role on every sign-in. |

Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated binding types (`worker-configuration.d.ts`).

## Local Development

```sh
npm install
npm start
```

`npm start` generates `wrangler.jsonc` from `wrangler.jsonc.tpl` and the committed local placeholder values in `infra/local-outputs.json`, generates binding types, applies the D1 migration to the local SQLite database (`db:migrate:local`), builds, and starts Vite. No Terraform state or cloud resources are required for the Access, D1, or SPA-shell behavior. Open the printed local address and sign in using the local Access dev-login form, which offers `admin@example.com` (this demo's local administrator) and `alice@example.com` (an ordinary identity). An always-visible **Sign out** control uses `/cdn-cgi/access/logout`, useful for recovering from having signed in as the wrong identity. Local D1 data lives under `.wrangler/` and can be deleted between sessions.

The `AI` binding has no local simulator (`docs/05-AI-CHAT.md`, "Workers AI Has No Local Simulation"): `vite dev` always reaches the real account for it, using the local placeholder AI Gateway id `"default"` (`infra/local-outputs.json`), which auto-provisions on first use. Signing in and sending a message locally makes a real, billable Workers AI call.

## Testing

```sh
npm run check          # format, lint, type check, Terraform fmt/validate
npm run test:unit      # Worker and client unit projects
npm run test:integration
npm run test:coverage
npm run build
```

`tests/integration/dynamic-routes.test.ts` (Phase 4) substitutes a fake `env.AI` binding, like every other integration test in this checkout, and asserts on the exact `dynamic/<route-name>` model id string `ChatAgent` calls -- it never makes a real call against AI Gateway, so it passes identically against the local placeholder route names (`infra/local-outputs.json`) or a real, deployed gateway.

## Deployment

```sh
cd demos/agentic-ai-chat
npm run deploy
```

`npm run deploy` runs `deploy:infra` (Terraform `init` then `apply -auto-approve`, reading configuration from `.env`) followed by `deploy:worker`. Before building, the `predeploy:worker` hook regenerates `wrangler.jsonc` from the live Terraform outputs (`generate-wrangler -cf --terraform infra`) and regenerates binding types (`generate-wrangler-types`). `deploy:worker` then applies D1 migrations to the remote database (`db:migrate:remote`), reads the Access application's real Audience tag from the `access_audience` Terraform output into the `VITE_ACCESS_AUDIENCE` build-time define, and runs `vite build && wrangler deploy`.

### Post-Deploy Verification

1. Visit `https://<DEMO_NAME>.<DEMO_DOMAIN>` (default `https://agentic-chat.cfapps.uk`) and authenticate through the configured identity provider.
2. Confirm the header shows your signed-in email and an **Administrator** badge only if you signed in as `ADMIN_EMAIL`.
3. Click **+ New Chat**. Confirm the "Mode" dropdown shows **Basic**, is enabled, and offers exactly "Basic"/"Reasoning".
4. Send a message in the composer and confirm a streamed response appears; confirm the "Mode" dropdown is now disabled.
5. Confirm the sidebar entry for this chat acquires a short generated title shortly after the response finishes.
6. Click **+ New Chat** again, switch its "Mode" to **Reasoning** before sending anything, then send a message and confirm a streamed response still appears.
7. Click back to the first chat in the sidebar and confirm its own history and "Basic" mode still load correctly.
8. Reload the page and confirm the same chat list and conversations reappear (loaded from D1 and the `ChatAgent` Durable Object's own storage, not browser memory).
9. Delete a chat from the sidebar and confirm it disappears from the list and the view falls back to a remaining chat (or the empty state if none remain).
10. Sign out using the visible **Sign out** control.
11. In the Cloudflare dashboard under **D1** > `<DEMO_NAME>-db` > Console, run `SELECT email, is_admin, created_at FROM users;` and confirm your identity was upserted with the expected `is_admin` value.
12. Under **Workers & Pages** > `<DEMO_NAME>` > **Logs**, confirm requests are being logged, including `chat_created`, `chat_connected`, `chat_route_changed`, and `chat_deleted` entries.
13. Under **AI Gateway** > `<DEMO_NAME>`, open the **Basic** and **Reasoning** dynamic routes and confirm each shows requests from the corresponding chat above, resolved to their own configured model.

## Provisioned Resources

- Worker (`<DEMO_NAME>`) serving the Vue shell as static assets and a Hono API.
- `CHAT_AGENT` Durable Object binding (`ChatAgent`, one instance per chat, `new_sqlite_classes` migration `v1`) -- created by Wrangler on first deploy, not Terraform (AGENTS.md, Resource Ownership).
- D1 database `<DEMO_NAME>-db`, bound as `DB`, holding the `users` and `chats` tables.
- AI Gateway `<DEMO_NAME>`, bound to the Worker as the `AI_GATEWAY_ID` var. Its two dynamic routes (`<DEMO_NAME>-basic`, `<DEMO_NAME>-reasoning`, bound as `AI_GATEWAY_ROUTE_BASIC`/`AI_GATEWAY_ROUTE_REASONING`) are what every chat turn now actually calls, selected per chat by the "Mode" dropdown ("Basic"/"Reasoning") rather than a raw model id.
- Custom domain `<DEMO_NAME>.<DEMO_DOMAIN>`.
- Access application + allow policy requiring authentication for the whole hostname, with `audience` pinned.
- Workers Logs (100% sampling) and traces (10% sampling).

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| Access denies sign-in | Confirm `CLOUDFLARE_TEAM_DOMAIN` and that an identity provider is enabled in the target Zero Trust organization, then re-run `npm run deploy`. |
| `401` from `/api/me` | Sign in through Access at `https://<DEMO_NAME>.<DEMO_DOMAIN>`; every API route requires a verified Access identity. |
| Domain fails to provision | Remove the conflicting DNS record and confirm the supplied zone ID owns `DEMO_DOMAIN`. |
| `generate:wrangler` fails during deploy | Run `npm run deploy:infra:apply` successfully first; every referenced Terraform output must exist. |
| D1 migration fails during deploy | Confirm Terraform apply completed (the D1 database must exist) before `db:migrate:remote` runs; re-run `npm run deploy`. |
| `vite dev`/`vitest` hang or fail to reach Workers AI | The `AI` binding has no local simulator and always reaches the real account; confirm the token has `Workers AI : Edit`. |
| Signed in but no `Administrator` badge | Confirm you signed in with the identity matching this deployment's `ADMIN_EMAIL`, and that D1 migrations have applied. |
| Composer stays disabled after sending the first message | The chat WebSocket has not reported `connected` yet; check the browser console/Workers Logs for a rejected upgrade (for example an expired Access session). |
| Sidebar shows "No chats yet" after a fresh deploy or teardown/re-deploy | Expected: the chat directory is a D1 table, so a freshly re-provisioned database starts empty; click **+ New Chat**. |
| A chat never acquires a title | Auto-titling is a best-effort second Workers AI call after the first turn (docs/06-AGENTIC-CHAT.md Section 11); check Workers Logs for a `chat_title_failed` entry -- the conversation itself is unaffected either way. |
| "Mode" dropdown is disabled and a route change returns `422` | Expected once a chat has a completed turn -- a chat's route can only be changed before its first turn finishes (docs/06-AGENTIC-CHAT.md Phase 4); start a new chat to pick a different mode. |
| A chat turn fails with an AI Gateway error after changing the dynamic route's model in the dashboard | Not every Workers AI model works when called through a dynamic route's model node (`spikes/01-ai-gateway-dynamic-routing/REPORT.md` Section 4); pick a model confirmed there, or re-verify a new one before assigning it to the route. |

## Teardown

```sh
cd demos/agentic-ai-chat
npm run teardown
```

`npm run teardown` runs `terraform destroy -auto-approve`, removing the Worker, D1 database, AI Gateway and its dynamic routes, custom domain, and Access application/policy, then deletes the locally generated `wrangler.jsonc` and `worker-configuration.d.ts`. Confirm no `<DEMO_NAME>` Worker, D1 database, AI Gateway, or Access application remain in the account before discarding local Terraform state.

See `EXPLAIN-DEMO.md` for what this demo teaches and how it works, and `DEMO.md` for a presenter's demo script.
