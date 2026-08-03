# Spike B Report — AI Gateway provisioning and dynamic routes as infrastructure

Run against the real account on 2026-08-03, using this repo's root `.env`. All resources this
spike created (the AI Gateway, both dynamic routes, the Access application/policy, the deployed
Worker, and every transient scratch route created against the account's pre-existing
`demo-gateway` while sweeping model compatibility) were torn down immediately after this report
was written; see "Cleanup performed" at the end.

## 1. Provisioning mechanism: Terraform, fully — with four non-obvious gotchas

The pinned `cloudflare/cloudflare ~> 5.22.0` provider's own schema (dumped directly with
`terraform providers schema -json`, since the public Terraform Registry page renders
client-side and could not be scraped) contains **both** resources this demo needs:

- `cloudflare_ai_gateway` — the gateway itself, including `spend_limits` (rules with
  `limit_type = "cost"`, a `window` in seconds, and a `metadata` map keyed by metadata field name
  with `mode = "partition"` or `"filter"` — exactly the "scope spend limits by custom metadata"
  shape the public dynamic-routing/spend-limits docs describe).
- `cloudflare_ai_gateway_dynamic_routing` — one resource per route, taking the exact same
  `elements` graph shape (`start`/`conditional`/`percentage`/`rate`/`model`/`end` nodes, each with
  an `id`, `type`, `outputs` (edges to other element `id`s), and type-specific `properties`) as
  the dashboard's own route builder and the plain JSON API.

`infra/main.tf` provisions one gateway (`spike-01-dynroute`) with a gateway-level spend limit,
and two routes end to end via a real `terraform apply`:

- `spike-basic-route`: `start -> model -> end`, no conditional — the simplest possible shape.
- `spike-governed-route`: `start -> conditional (metadata.business) -> [true: rate-limit ->
  model(reasoning) | false: model(basic)] -> end` — the exact shape US-7 (metadata-driven
  routing) needs, plus a rate-limit node on the same route to prove that node type too.

Both `terraform apply`s succeeded and the resulting routes were confirmed callable end to end
(Section 3). **Conclusion for Phase 1 Scaffolding: no hand-written provisioning script is
needed for the gateway or its routes** — this contradicts the scenario doc's original hedge
("versus what must be created through a small idempotent script"); Terraform alone is
sufficient, once the four gotchas below are worked around.

### Gotcha 1 — a model node's `provider` field is renamed in Terraform's HCL

The raw JSON API's `properties` for a `model` node are `{ model, provider, retries, timeout }`
(confirmed by reading back this account's own pre-existing, dashboard-authored
`demo-gateway`/`actor-model-routing` route via `GET .../routes/{id}`). But the Terraform
resource's own schema for `elements.properties` has **no** `provider` attribute at all — instead
it has `ai_gateway_dynamic_routing_provider`. Using the plain `provider` name is not rejected by
`terraform plan`'s schema validation (Terraform silently drops it — it never appears in the plan
diff or the applied state); the resulting `apply` then fails at the API call itself:

```
Error: failed to make http request
POST ".../ai-gateway/gateways/spike-01-dynroute/routes": 400 Bad Request
{"errors":[{"code":7001,"message":"Required","path":["body","elements",1,"properties","provider"]}]}
```

Fix: use `ai_gateway_dynamic_routing_provider = "workers-ai"` in HCL; the provider maps it back
to the API's `provider` key on the wire.

### Gotcha 2 — `conditions` is a plain string attribute; the real syntax is a Mongo-style query object

`elements.properties.conditions` is typed as a plain `string` in the Terraform schema, but the
JSON API's own shape for it — reverse-engineered by reading back the account's pre-existing
`actor-model-routing` route, since neither the public docs nor the generated `cloudflare-typescript`
SDK types (`Properties { conditions?: unknown }`) state it anywhere — is a small Mongo-style query
object keyed by dotted metadata path:

```json
{ "metadata.actor": { "$eq": "agent" } }
```

So HCL must `jsonencode()` the object into the string attribute:

```hcl
properties = {
  conditions = jsonencode({
    "metadata.business" = { "$eq" = "leadership" }
  })
}
```

This is exactly the syntax `docs/06-AGENTIC-CHAT.md`'s US-7 needs (`metadata.business ==
"leadership"`), and Section 3 below confirms it actually steers the resolved model, not just that
`apply` accepts it.

### Gotcha 3 — the dynamic-routing resource is not plan-stable after the first apply

Immediately after a clean `terraform apply` (`terraform state show` confirms `elements` is fully
populated, straight from the create response), running `terraform plan` again — with **zero**
config changes — proposes destroying and recreating **both** routes:

```
# cloudflare_ai_gateway_dynamic_routing.basic must be replaced
-/+ resource "cloudflare_ai_gateway_dynamic_routing" "basic" {
      + elements    = [ # forces replacement
          ...
        ]
      ...
```

Root cause: the API's `GET .../routes/{id}` response does **not** return a top-level `elements`
field at all — it nests the identical array one level down, under `version.data`. This
provider version's `Read` for `cloudflare_ai_gateway_dynamic_routing` does not map
`version.data` back onto the `elements` attribute, so every refresh reads `elements` back empty,
Terraform diffs that against the non-empty config, and — because `elements` is a list attribute,
not a map keyed by a stable id — proposes a full replace rather than an in-place update.

Fix applied here: `lifecycle { ignore_changes = [elements] }` on both route resources — the same
category of "narrow, explicit provider-limitation workaround, not a normal-diff shrug" this
account's docs already sanction for the bootstrap-deployment exception. `terraform plan` is clean
(`No changes.`) after adding it. **Consequence for later phases**: any phase that needs to
*change* a route's shape (for example, Phase 8 adding a new spend-limit node) cannot rely on a
plain `terraform apply` picking the change up — it must run `terraform apply
-replace=cloudflare_ai_gateway_dynamic_routing.<name>` deliberately. Flag this explicitly wherever
Phase 4/7/8 documents how to change a route later.

### Gotcha 4 — four `cloudflare_ai_gateway` fields need pinning to reach a stable plan

`log_management`, `log_management_strategy`, `zdr`, and `logpush` are all optional-but-not-
computed in this resource's schema. Leaving any of them unset lets the API silently fill in its
own defaults (`10000000` / `"DELETE_OLDEST"` / `false` / `false`); Terraform then reads those
server-filled values back on the next `plan` and — because the config still says nothing, i.e.
"should be null" — proposes removing them, forever. Pinning all four explicitly in HCL to the
values the API itself defaults to reaches a clean, no-op `terraform plan`.

## 2. Creating a route auto-deploys it — no separate deployment step

`POST .../routes` (what both Terraform's `create()` and the plain API do) returns a response
whose `version` **and** `deployment` objects are both already populated (`version.active: true`,
a real `deployment.deployment_id`) — confirmed with a raw scratch `curl` before ever touching
Terraform. There is no `cloudflare_ai_gateway_dynamic_routing_deployment` resource in this
provider version (and none is needed): the single resource's one `create` call is both the
version and its live deployment in one step.

## 3. Calling a route: both invocation methods work; only one preserves a usable log ID

Calling `model = "dynamic/<route-name>"` in place of a literal model ID worked identically
through:

- **The Workers `AI` binding** — `env.AI.run("dynamic/spike-basic-route", { messages: [...] },
  { gateway: { id: "spike-01-dynroute", metadata: { business: "leadership" } } })`, from a
  deployed Worker.
- **The plain REST API** — `POST /accounts/{account}/ai/v1/chat/completions` with header
  `cf-aig-gateway-id: <gateway>` and body `{ "model": "dynamic/<name>", "messages": [...] }`
  (confirmed against both this spike's own gateway and the account's pre-existing
  `demo-gateway`/`actor-model-routing`) — matching the public dynamic-routing docs' "getting
  started" step exactly.

**The conditional node genuinely steers the resolved model, live, not just on paper.** Calling
`spike-governed-route` with `metadata: { business: "leadership" }` resolved to
`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` (the reasoning-tier branch) every time; any other
`business` value (or none) resolved to `@cf/google/gemma-4-26b-a4b-it` (the basic-tier branch)
every time — cross-checked against the gateway's own logs list, not only the Worker's own
response.

**The rate-limit node genuinely gates a branch, live.** With `limit = 2, window = 60` on the
"true" branch, the first two `leadership` calls within the window both resolved to the
reasoning-tier model; the third and fourth (same window) automatically fell back to the
basic-tier model with no application-level retry logic — exactly the "switches to fallback when
exceeded" behavior the dynamic-routing docs describe.

### `env.AI.aiGatewayLogId` is null for every dynamic-route call — a real correction to Section 6.6

This is the most consequential finding in this spike. Calling a **literal** model ID through
`env.AI.run()` populates `env.AI.aiGatewayLogId` with a real, `getLog()`-able id (confirmed:
`env.AI.gateway(id).getLog(thatId)` returned the full, correct `AiGatewayLog` record). Calling
the **exact same gateway** with a **dynamic route name** as the model argument leaves
`env.AI.aiGatewayLogId` **`null`**, reproduced consistently across both routes, with and without
metadata, and across every successful and failed call in this sweep (a dozen-plus calls total).

This directly undermines Section 6.6's reconciliation design as originally written, which assumes
`this.schedule("reconcileUsage", { gatewayLogId: this.env.AI.aiGatewayLogId, ... })` works for
every completed turn — but every real Phase 4-onward turn calls a dynamic route by name, not a
literal model ID, so `aiGatewayLogId` will be `null` for all of them.

**A viable fallback exists, but is not yet a complete answer** — this is exactly why Spike F
(which explicitly depends on this spike) must resolve it before Phase 6 is designed, not inherit
an assumption:

- AI Gateway's own logs-list API (`GET /accounts/{account}/ai-gateway/gateways/{id}/logs`) DOES
  record a full entry for the **resolved underlying model** of every dynamic-route call that
  reaches a model node — real `cost`, real `tokens_in`/`tokens_out`, and the request's own
  `metadata` — even though `aiGatewayLogId` came back `null`. In principle, querying this list
  (sorted `created_at` desc, filtered by the turn's own distinguishing metadata and a tight time
  window immediately after the call resolves) could substitute for `getLog(aiGatewayLogId)`.
- However, the two mechanisms that would make that filtering *precise* did not work as
  documented in this sweep: sending a custom `cf-aig-event-id` header (or the binding's
  `gateway.eventId` option) did not appear on the resulting log entry's own `event_id` field
  (it stayed `""`), and the logs-list endpoint's own `event_id` query parameter did not filter
  the returned page at all (it returned every log regardless). Neither was investigated further
  here — pinning down a reliable "which exact call produced which exact log row" correlation
  mechanism for a dynamic-route call is squarely Spike F's job.
- A dynamic-route call whose **every branch fails** to resolve (Section 4) produces its own
  separate, distinct log entry for `model: "dynamic/<route-name>"` itself, `provider: "unknown"`,
  `cost: 0`, `success: false` — a top-level "the route itself couldn't satisfy this request"
  record, only surfaced when nothing further down the graph could. A successful call produces
  exactly one entry, for the resolved model only; no separate "dynamic/..." parent entry appears
  in the success case.

**Action taken**: this finding, and the open question it leaves for Spike F, are recorded
directly in `docs/06-AGENTIC-CHAT.md`'s Section 6.6 and Spike F's own aim (Section 8/9), per the
required feedback action.

### `AiGatewayLog`'s real field names (confirmed, both via the binding and the raw REST logs API)

```
{
  id, provider, model, model_type, path, duration,
  status_code, success, cached,
  tokens_in, tokens_out,      // NOT prompt_tokens/completion_tokens
  metadata, cost,             // cost is a plain USD number
  usage_metadata: { input_tokens, output_tokens, total_tokens?, neurons? }, // a second, differently-named duplicate
  request_head, response_head, request_size, response_size, ...
}
```

`getLog()`'s "not found" signal (confirmed live, calling it with a made-up id) is a **thrown
error**, not a `404`-shaped return value or an empty/`null` field:

```
AiGatewayLogNotFound: Log not found
```

Section 6.4's `chat_usage` table names its own columns `prompt_tokens`/`completion_tokens` —
Phase 6's reconciliation code must explicitly map from `tokens_in`/`tokens_out`/`cost`, not
assume the gateway log shares those column names.

## 4. Not every catalog model works through a dynamic route's model node

While preparing a "basic tier" model for `spike-basic-route`, the scenario doc's usual
non-reasoning pick — `@cf/ibm-granite/granite-4.0-h-micro` (demo 5's own verified catalog,
reused as-is by Spike A) — failed **every single call** routed through a dynamic route's model
node, both via `env.AI.run()` and the plain REST endpoint, with:

```
AiGatewayError: 2002: Failed to parse model output
```

This does not happen calling the same model directly (outside a dynamic route) anywhere else in
this repo (Spike A's own probe uses it successfully as its default non-reasoning model) — so this
is a property of the dynamic route's own model-node response adapter, not the model itself being
broken.

A sweep of eight catalog models against a disposable scratch route on the account's pre-existing
`demo-gateway` (created and deleted per model, to isolate the model-node adapter from anything
route-graph-specific) found:

| Model | Works through a dynamic route? |
| --- | --- |
| `@cf/zai-org/glm-5.2` | Yes (also the account's own pre-existing `actor-model-routing` route already used it successfully) |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | Yes |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | Yes |
| `@cf/google/gemma-4-26b-a4b-it` | Yes (one-off transient `2002` failure was also observed once, not reproduced on immediate retry — treat as flaky, not "broken") |
| `@cf/ibm-granite/granite-4.0-h-micro` | **No** — `2002` every time |
| `@cf/meta/llama-3.1-8b-instruct` | **No** — `7003` ("Model execution failed (Error)") |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | **No** — `2002` |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | **No** — `2002` |
| `@cf/openai/gpt-oss-120b` | **No** — `2002` |
| `@cf/zai-org/glm-4.7-flash` | **No** — `2002` (observed both standalone and as the account's pre-existing route's own "agent" branch) |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | **No** — `7003` |
| `@cf/meta/llama-3.2-3b-instruct` | **No** — `7003` |

**No clean correlation with `docs/05-AI-CHAT.md`'s declared adapter family** (`openai-chat` vs.
`cf-native`) predicts this: `glm-4.7-flash` and `gemma-4-26b-a4b-it` are both `openai-chat`/
`reasoning-field` per that catalog, yet one works through a dynamic route and the other does not;
`deepseek-r1-distill-qwen-32b` (`cf-native`) works, `granite-4.0-h-micro` (also `cf-native`) does
not. This is consistent with `docs/DECISIONS.md` #10's own warning that "shares an input type"
does not imply "shares an output shape" — extended here to a third layer (the dynamic route's own
model-node adapter, on top of the model's raw streaming shape and the `openai-chat`/`cf-native`
non-streaming adapter).

**Action taken**: `infra/main.tf`'s two routes were built with `@cf/google/gemma-4-26b-a4b-it`
(basic tier) and `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` (reasoning tier) — both confirmed
live — instead of Spike A's Granite/DeepSeek pairing. `docs/06-AGENTIC-CHAT.md` is updated to
require that Phase 4 spike its *own* chosen dynamic-route catalog against a real route before
relying on it, rather than assuming compatibility carries over from Spike A's direct-call
findings.

## 5. `spend_limits` provisioned and confirmed live

The gateway-level spend limit (`limit_type = "cost", limit = 1, window = 86400, metadata =
{ business = { mode = "partition" } }`) applied via Terraform was confirmed present, with the
exact partition-by-metadata shape intact, by reading the gateway back directly:

```json
"spend_limits": {
  "enabled": true,
  "rules": [{
    "id": "6fb25042", "enabled": true, "limitType": "cost", "limit": 1,
    "window": 86400, "technique": "sliding",
    "metadata": { "business": { "mode": "partition" } }
  }]
}
```

This spike did not attempt to actually exhaust the $1/day budget live (that would need dozens of
real calls purely to trigger it, for no additional information over confirming the shape landed
correctly) — Phase 8, which owns spend limits as a feature, should be the one to verify the
`429`-and-fallback behavior the public docs describe.

## Corrections applied to `docs/06-AGENTIC-CHAT.md`

1. Section 6.3 — added a note that a dynamic route's model catalog must be verified per-model
   against a live route (Section 4's model-compatibility sweep), not assumed from a model's
   direct-call behavior, with the confirmed working/failing model lists and the confirmed
   `conditions` expression syntax.
2. Section 6.6 — added a note that `env.AI.aiGatewayLogId` is confirmed `null` for dynamic-route
   calls specifically, with the reproduction summary and the open log-correlation question this
   leaves for Spike F.
3. Spike F's own aim (Section 9, Phase 0) — rewritten to make "find a working log-correlation
   mechanism for a dynamic-route call" its central, still-open question, rather than "does
   `aiGatewayLogId` work" (now answered: no).
4. Phase 1 Scaffolding's provisioning step (Section 9) — updated from "to whatever extent Spike B
   found Terraform-manageable" to state plainly that the gateway and both routes are fully
   Terraform-manageable, and to name the three HCL gotchas (Gotchas 1–3 above) to copy verbatim.

See the corresponding `docs/DECISIONS.md` "NEW DECISIONS" entry for the condensed, reusable
version of all of the above.

## Cleanup performed

- `cd infra && terraform destroy` — removed both dynamic routes, the AI Gateway, and the Access
  application/policy.
- `wrangler delete` — removed the deployed `spike-01-ai-gateway-dynamic-routing` Worker.
- Every transient scratch route created directly against the account's pre-existing
  `demo-gateway` during the Section 4 model sweep was deleted immediately after each test call
  (confirmed: re-listing `demo-gateway`'s routes afterward showed only its original,
  pre-existing `actor-model-routing` route — nothing this spike added was left behind).
