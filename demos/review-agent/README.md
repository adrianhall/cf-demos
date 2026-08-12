# PR Review Agent

An agentic PR/MR review bot for GitHub and GitLab based on Cloudflare Workers, Durable Objects (Agents SDK), Cloudflare Workflows, Workers AI, AI Gateway, D1, and Cloudflare Access.

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches and how it works, and [`DEMO.md`](./DEMO.md) for a presenter's demo script.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare account with a zone that can host `<DEMO_NAME>.<DEMO_DOMAIN>` (default `review-agent.cfapps.uk`) and no conflicting CNAME on that hostname.
- A Cloudflare Zero Trust team with an identity provider that can authenticate reviewers.
- A GitHub personal access token (`repo` scope for a classic PAT, or `Contents: Read` plus `Pull requests: Read and write` for a fine-grained one) and/or a GitLab personal access token (`read_api` + `api` scope), for whichever provider(s) you want to review.
- A shared secret configured on the target repository's/project's own webhook, for whichever provider(s) you want to trigger reviews automatically.
- A Cloudflare API token scoped to the target account and zone with:
  - Entire Account > Developer Platform > Workers Scripts: Edit
  - Entire Account > Developer Platform > D1: Edit
  - Entire Account > Developer Platform > Workers AI: Read
  - Entire Account > Developer Platform > AI Gateway: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Identity Providers: Read
  - `<your-domain>` > DNS & Zones > DNS: Write

## Environment Configuration

This demo's environment configuration is split across three files, unlike most demos in this repository:

```sh
cd demos/review-agent
cp .env.example .env
cp .dev.vars.example .dev.vars
```

- **`.env`** — Cloudflare API credentials and deployment target, read by Terraform. Set every value in the table below.
- **`.dev.vars`** — local-only GitHub/GitLab credentials for `npm start`. **Unlike every other demo in this repository, `.dev.vars` is gitignored here, not committed** ([Explicit Exceptions](../../docs/07-PR-REVIEW-AGENT.md#explicit-exceptions)): every other demo's `.dev.vars` holds only non-secret local overrides safe to commit, but this demo's local development story genuinely needs your own GitHub/GitLab personal access tokens and webhook secrets to exercise provider-calling code end to end. Fill in `.dev.vars` from `.dev.vars.example`'s comments before running `npm start`.
- **Production secrets** — set once after the first deploy via `wrangler secret put` (see "Deployment" below), never committed anywhere.

| `.env` variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the permissions listed above. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker, D1 database, AI Gateway, and Access applications. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `DEMO_DOMAIN`. |
| `DEMO_DOMAIN` | Zone hostname the demo is deployed under, e.g. `cfapps.uk`. |
| `DEMO_NAME` | Worker name and hostname label, e.g. `review-agent` for `review-agent.cfapps.uk`. |
| `CLOUDFLARE_TEAM_DOMAIN` | Access team domain without `https://`, e.g. `example.cloudflareaccess.com`. |

Do not commit `.env`, `.dev.vars`, Terraform state, the generated `wrangler.jsonc`, or generated binding types (`worker-configuration.d.ts`).

### Narrowing Access

By default, every path on this hostname other than the two webhook routes requires only *any* authenticated identity in your Cloudflare Access team (`infra/review-agent.tf`'s `cloudflare_zero_trust_access_policy.demo`, an `allow` policy with `include = [{ everyone = {} }]`) — triggering a review spends real AI Gateway budget, so an operator who wants stricter cost control should narrow this policy's `include` to specific emails, an email domain, or a group before deploying to a real team, the same way demo 5 documents for its own inference endpoint. Edit that policy's `include` block in `infra/review-agent.tf` and re-run `npm run deploy`.

## Local Development

```sh
npm install
npm start
```

`npm start` builds and serves the Worker and browser UI locally against `wrangler.jsonc`, generated from `wrangler.jsonc.tpl` and the committed local placeholder values in `infra/local-outputs.json`, applies D1 migrations locally, and starts `vite dev`. No Terraform state or cloud resources are required. Open `http://localhost:5173/` and sign in using the local Access dev-login form. `env.AI` has no local simulator (Workers AI is not available in `vite dev`); local development that needs a real reviewer AI call requires `wrangler dev --remote` or a deployed Worker. Local D1/Durable Object/Workflow state lives under `.wrangler/` and can be deleted between sessions.

## Testing

```sh
npm run check          # format, lint, type check, Terraform fmt/validate
npm run test:unit      # Worker and client unit projects
npm run test:integration
npm run test:coverage
npm run build
```

Integration tests run against a real, local Cloudflare Workflows engine, a real D1 binding, and a real `ReviewRunAgent` Durable Object — but a scripted fake `Ai` (Workers AI has no local simulator, so a fake substitutes for it — see `tests/integration/support/fixtures.ts`) and a scripted `fetch` mock standing in for GitHub/GitLab's own REST APIs.

## Deployment

```sh
cd demos/review-agent
npm run deploy
```

`npm run deploy` runs `deploy:infra` (Terraform `init` then `apply -auto-approve`, reading configuration from `.env`) followed by `deploy:worker` (`db:migrate:remote`, then `vite build && wrangler deploy`). Before building, the `predeploy:worker` hook regenerates `wrangler.jsonc` from the live Terraform outputs (`generate-wrangler -cf --terraform infra`) and regenerates binding types (`generate-wrangler-types`).

### One-Time Secrets

After the **first** successful deploy, set the GitHub/GitLab credentials as Wrangler secrets — these are never a Terraform output or a `wrangler.jsonc` value, and are your responsibility to create, rotate, and revoke:

```sh
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITLAB_TOKEN
npx wrangler secret put GITLAB_WEBHOOK_SECRET
```

Skip whichever provider's pair you do not intend to use — the Worker's own routes for that provider will simply never be called by a request in practice. `GITLAB_BASE_URL` (default `https://gitlab.com`) is set the same way only if you use a self-managed GitLab instance:

```sh
npx wrangler secret put GITLAB_BASE_URL
```

### Post-Deploy Verification

1. Configure a webhook on a real GitHub repository (**Settings > Webhooks > Add webhook**) pointing at `https://<DEMO_NAME>.<DEMO_DOMAIN>/api/webhooks/github`, content type `application/json`, the same secret you set as `GITHUB_WEBHOOK_SECRET`, and the **Pull requests** event only. (GitLab: **Settings > Webhooks**, URL `.../api/webhooks/gitlab`, **Merge request events**, and the shared secret as the webhook's **Secret token**.)
2. Open a pull request in that repository.
3. Visit `https://<DEMO_NAME>.<DEMO_DOMAIN>/` and sign in through your identity provider. The triggered run should appear at the top of the history list with status "Running" within moments.
4. Open the run's detail page and confirm each reviewer's badge progresses to "Done" (or "Skipped").
5. Find this run's Workflow instance either in the Cloudflare dashboard (**Workers & Pages** > `<DEMO_NAME>` > **Workflows**) or via `wrangler workflows instances describe review-pipeline-workflow <instance-id>` — the run's detail page does not surface the instance id directly today, but the Workflow's own dashboard list is ordered by creation time.
6. Once the run completes, confirm the posted comment appears on the pull request.

## Provisioned Resources

- Worker (`<DEMO_NAME>`) serving the Vue browser UI as static assets and a Hono API.
- `ReviewRunAgent` Durable Object (`REVIEW_RUN` binding) and `ReviewPipelineWorkflow` Workflow (`REVIEW_PIPELINE` binding) — both declared entirely in `wrangler.jsonc`, with no separate Terraform resource.
- D1 database `<DEMO_NAME>-db`, bound as `DB`.
- A dedicated AI Gateway (`<DEMO_NAME>-gateway`), not the account's `default` gateway.
- Custom domain `<DEMO_NAME>.<DEMO_DOMAIN>`.
- Access application + `allow` policy covering the whole hostname (any authenticated identity).
- Access application + `bypass` policy scoped to exactly `/api/webhooks/github` and `/api/webhooks/gitlab`.
- Workers Logs (100% sampling) and traces (10% sampling).

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| A webhook delivery never starts a run | Confirm the webhook's own secret matches the deployed `GITHUB_WEBHOOK_SECRET`/`GITLAB_WEBHOOK_SECRET` exactly, and that the delivery's event type is tracked (GitHub `pull_request`, action `opened`/`synchronize`/`reopened`; GitLab `Merge Request Hook`, action `open`/`update`/`reopen`). Check the provider's own webhook delivery log for the HTTP status this Worker returned. |
| Webhook delivery returns `401` | Signature/token mismatch — re-run `wrangler secret put GITHUB_WEBHOOK_SECRET`/`GITLAB_WEBHOOK_SECRET` with the exact value configured on the provider's webhook. |
| `POST /api/reviews` (manual trigger) returns `400` | The pasted URL does not resolve to a real, reachable PR/MR with the configured token — confirm the URL and that `GITHUB_TOKEN`/`GITLAB_TOKEN` can read that repository. |
| A run's reviewer badge stays "Running" indefinitely | Open the Workflow instance's own step timeline (Cloudflare dashboard or `wrangler workflows instances describe`) — a step with exhausted retries records that reviewer `"error"` and the run still completes; a run that never reaches `"completed"`/`"failed"` at all indicates the Workflow instance itself is still retrying a step. |
| A reviewer's cost stays "Pending" | AI Gateway has not yet indexed that call's log — this resolves itself within the reconciliation step's own retry window (about 40 seconds). If it never resolves, `cost_source` stays `pending` permanently by design; check the AI Gateway dashboard directly for that call. |
| `generate:wrangler` fails during deploy | Run `npm run deploy:infra:apply` successfully first; every referenced Terraform output must exist. |
| Domain fails to provision | Remove the conflicting DNS record and confirm the supplied zone ID owns `DEMO_DOMAIN`. |

## Teardown

```sh
cd demos/review-agent
npm run teardown
```

`npm run teardown` runs `terraform destroy -auto-approve`, removing the Worker (and, with it, the `ReviewRunAgent` Durable Object and `ReviewPipelineWorkflow` Workflow it declares — neither has a separate Terraform resource to destroy), the D1 database, the AI Gateway, the custom domain, and both Access applications/policies, then deletes the locally generated `wrangler.jsonc` and `worker-configuration.d.ts`. This does not revoke the GitHub/GitLab personal access tokens or remove the webhook you configured on the provider's own repository/project settings — remove those yourself if you no longer need them. Confirm no `<DEMO_NAME>` Worker, D1 database, AI Gateway, or Access applications remain in the account before discarding local Terraform state.
