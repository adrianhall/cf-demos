# Minimal, spike-scoped Terraform (docs/06-AGENTIC-CHAT.md, Section 8). Spike F's aim is to
# determine exactly how this demo reads back a completed turn's authoritative cost/token counts
# for a *dynamic-route* call, since Spike B (spikes/01-ai-gateway-dynamic-routing/REPORT.md)
# confirmed `env.AI.aiGatewayLogId` is `null` for every such call — the reconciliation design in
# docs/06-AGENTIC-CHAT.md Section 6.6 cannot schedule `getLog(aiGatewayLogId)` as originally
# written. This spike needs its own dedicated gateway and one simple dynamic route (reusing Spike
# B's confirmed-working model, `@cf/google/gemma-4-26b-a4b-it`, since not every catalog model
# works through a dynamic route's model node) to generate real dynamic-route log rows to
# correlate against — the account's pre-existing `demo-gateway` is left alone entirely so this
# spike's teardown blast radius is exactly what it creates.
#
# This spike also deploys its Worker and drives it over its own public hostname, for the same
# reason Spikes A and B did: `env.AI` has no local remote-binding simulation on this account
# (Spike A's finding), so a live `env.AI.run()` call can only be observed against a real
# deployment. Per Section 8 it MUST therefore front that hostname with a bypass-all Access
# application/policy, reusing this repo's own dotenv-provider and bypass-policy conventions
# verbatim (AGENTS.md, Public Access; spikes/00-aichatagent-basics/infra/main.tf;
# spikes/01-ai-gateway-dynamic-routing/infra/main.tf).
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22.0"
    }
    dotenv = {
      source  = "jrhouston/dotenv"
      version = "~> 1.0"
    }
  }
}

data "dotenv" "config" {
  filename = "${path.module}/../../../.env"
}

provider "cloudflare" {
  api_token = local.cloudflare_api_token
}

locals {
  cloudflare_api_token  = sensitive(data.dotenv.config.env["CLOUDFLARE_API_TOKEN"])
  cloudflare_account_id = data.dotenv.config.env["CLOUDFLARE_ACCOUNT_ID"]

  # The Worker's name, matching wrangler.jsonc's "name" field — Terraform does not own the Worker
  # resource itself for this spike (Wrangler owns the whole deploy); Terraform only needs the
  # name to build the workers.dev hostname the Access application fronts.
  worker_name = "spike-04-ai-gateway-cost-reconciliation"

  # This account's workers.dev subdomain — see spikes/00-aichatagent-basics/infra/main.tf for why
  # this is a hardcoded local rather than a data source (no Terraform data source exists for it;
  # it is a stable, account-wide dashboard setting, not a per-worker resource).
  workers_dev_subdomain = "adrian-hall-internal-demo"

  hostname = "${local.worker_name}.${local.workers_dev_subdomain}.workers.dev"

  # A short, dedicated AI Gateway id, distinct from Spike B's own (already torn down) and from
  # the account's pre-existing `default`/`demo-gateway` gateways.
  ai_gateway_id = "spike-04-cost-recon"
}

# Bypass-all policy: this spike's own `scripts/probe.mjs`/curl needs to hit the endpoint directly
# with no Access authentication dance of its own to build (AGENTS.md, Public Access; Section 8).
resource "cloudflare_zero_trust_access_policy" "bypass" {
  account_id = local.cloudflare_account_id
  name       = "${local.worker_name} spike bypass"
  decision   = "bypass"

  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "spike" {
  account_id = local.cloudflare_account_id
  name       = local.worker_name
  domain     = local.hostname
  type       = "self_hosted"

  destinations = [{
    type = "public"
    uri  = local.hostname
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.bypass.id
    precedence = 1
  }]
}

# The AI Gateway itself. Every optional-but-not-computed field is pinned explicitly to the value
# the API itself would otherwise silently default to server-side — Spike B's Gotcha 4
# (spikes/01-ai-gateway-dynamic-routing/REPORT.md) found that leaving any of them unset means
# Terraform reads the server-filled default back on the very next `plan` and proposes removing it
# forever, since the config still says "should be null".
resource "cloudflare_ai_gateway" "spike" {
  account_id                 = local.cloudflare_account_id
  id                         = local.ai_gateway_id
  authentication             = false
  cache_invalidate_on_update = true
  cache_ttl                  = 0
  collect_logs               = true
  logpush                    = false
  log_management             = 10000000
  log_management_strategy    = "DELETE_OLDEST"
  zdr                        = false
  rate_limiting_interval     = 0
  rate_limiting_limit        = 0
}

# One route, the simplest possible shape (start -> model -> end, no conditional) — this spike's
# question is entirely about *reading back* a dynamic-route call's cost/log after the fact, not
# about routing logic itself (Spike B already answered that), so no conditional/rate-limit node
# is needed here.
#
# Model choice: `@cf/google/gemma-4-26b-a4b-it`, one of only four catalog models Spike B confirmed
# actually work when invoked through a dynamic route's "model" node (most of demo 5's/Spike A's
# usual catalog fails with `AiGatewayError 2002` specifically inside a dynamic route — see
# spikes/01-ai-gateway-dynamic-routing/REPORT.md Section 4).
resource "cloudflare_ai_gateway_dynamic_routing" "route" {
  account_id = local.cloudflare_account_id
  gateway_id = cloudflare_ai_gateway.spike.id
  name       = "spike-cost-recon-route"

  elements = [
    {
      id   = "start"
      type = "start"
      outputs = {
        next = { element_id = "model" }
      }
    },
    {
      id   = "model"
      type = "model"
      properties = {
        model                               = "@cf/google/gemma-4-26b-a4b-it"
        ai_gateway_dynamic_routing_provider = "workers-ai"
        timeout                             = 60000
        retries                             = 1
      }
      outputs = {
        success  = { element_id = "end" }
        fallback = { element_id = "end" }
      }
    },
    {
      id      = "end"
      type    = "end"
      outputs = {}
    },
  ]

  # Same provider limitation Spike B's Gotcha 3 documented in full: this provider version's
  # `Read` never repopulates `elements` from `GET .../routes/{id}` (the API nests it one level
  # down, under `version.data`), so every `terraform plan` after the first `apply` otherwise
  # proposes destroying and recreating the route with zero config changes.
  lifecycle {
    ignore_changes = [elements]
  }
}

output "hostname" {
  value = local.hostname
}

output "ai_gateway_id" {
  value = cloudflare_ai_gateway.spike.id
}

output "route_name" {
  value = cloudflare_ai_gateway_dynamic_routing.route.name
}
