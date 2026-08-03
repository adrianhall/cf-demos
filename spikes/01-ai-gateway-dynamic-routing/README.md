# Spike B — AI Gateway provisioning and dynamic routes as infrastructure

Answers the question docs/06-AGENTIC-CHAT.md's Section 9, Phase 0 "Spike B" poses: how much of
the AI Gateway configuration Demo 6 needs — the gateway itself, its two dynamic routes, and
their conditional/rate-limit/spend-limit nodes — can be created and versioned through Terraform
against the pinned `cloudflare/cloudflare ~> 5.22.0` provider, versus what would need a
hand-written script; the exact request shape for calling a route in place of a model; the exact
conditional-expression syntax for branching on custom metadata; and how to read back a turn's
real cost.

See REPORT.md for everything this spike actually found, including two corrections to
docs/06-AGENTIC-CHAT.md's assumptions that are load-bearing for later phases (already applied to
that document directly, per Section 8's required feedback actions).

## What this spike deploys

- `infra/main.tf` — one AI Gateway (`cloudflare_ai_gateway`) with a gateway-level spend limit,
  and two dynamic routes (`cloudflare_ai_gateway_dynamic_routing`): `spike-basic-route` (a single
  model node, no conditional) and `spike-governed-route` (a conditional node keyed on
  `metadata.business`, with a rate-limit node gating its "true" branch).
- A deployed Worker (`src/index.ts`) exposing `GET /call?route=basic|governed|direct` (calls the
  named route, or a literal model ID as a control, through `env.AI.run()`) and
  `GET /log?id=<aiGatewayLogId>` (exchanges a log ID for `env.AI.gateway(id).getLog()`'s
  authoritative cost/token figures).

This spike deploys a real, publicly reachable Worker rather than staying inside `wrangler dev`
against a remote binding, because the operator's sandbox in this run could not open the
remote-binding proxy session `wrangler dev --remote`/`vitest-pool-workers` needs to reach the
real account — and, independent of that, `env.AI.aiGatewayLogId` and
`env.AI.gateway(id).getLog()` are Workers Runtime binding features with no plain-HTTP equivalent,
so they can only be observed against a real deployed Worker in the first place (confirmed by
`curl`-ing the AI Gateway REST endpoints directly and finding no log-id-bearing header or body
field anywhere in their responses — see REPORT.md).

## Access application (Section 8, second spike category)

This spike's Worker is fronted by a bypass-all Cloudflare Access application/policy, created and
torn down entirely by `infra/main.tf` (mechanism 1 of Section 8's two sanctioned options — a
minimal, spike-scoped Terraform config, copied verbatim from
`spikes/00-aichatagent-basics/infra/main.tf`'s own pattern). No manual Access step is needed.

## Reproduce

```sh
npm install
cd infra && terraform init && terraform apply
cd ..
npm run deploy
```

Then, from the deployed hostname (`terraform -chdir=infra output -raw hostname`):

```sh
HOST="https://$(terraform -chdir=infra output -raw hostname)"
curl -s "$HOST/call?route=basic"
curl -s "$HOST/call?route=governed&business=leadership"
curl -s "$HOST/call?route=governed&business=field"
curl -s "$HOST/log?id=<an aiGatewayLogId a /call response returned>"
```

## Teardown

```sh
cd infra && terraform destroy
cd .. && wrangler delete
```

`terraform destroy` removes the AI Gateway, both dynamic routes, and the Access
application/policy. `wrangler delete` removes the deployed Worker. Neither leaves a named or
billable resource behind. This spike created and deleted several transient scratch routes
directly on the account's pre-existing `demo-gateway` while sweeping model compatibility
(REPORT.md); none were left behind (confirmed by re-listing that gateway's routes afterward — see
REPORT.md's model-compatibility section).
