# Minimal, spike-scoped Terraform (docs/06-AGENTIC-CHAT.md, Section 8). Spike B's aim is to
# determine how much of the AI Gateway configuration this demo needs — the gateway itself, the
# two dynamic routes, and their conditional/rate-limit/spend-limit nodes — can be created and
# versioned through Terraform against the pinned `cloudflare/cloudflare ~> 5.22.0` provider,
# versus what would need a hand-written script. See REPORT.md: all of it is Terraform-manageable
# via `cloudflare_ai_gateway` and `cloudflare_ai_gateway_dynamic_routing`, both present in this
# provider version's schema (confirmed by dumping `terraform providers schema -json`, since the
# public Terraform Registry page renders client-side and could not be scraped directly).
#
# This spike also deploys its Worker and drives it over its own public hostname (the exact
# reason: obtaining `env.AI.aiGatewayLogId` and calling `env.AI.gateway(id).getLog()` are Workers
# Runtime binding features with no equivalent in the plain HTTP API, per REPORT.md — they cannot
# be observed with `curl` alone), so per Section 8 it MUST front that hostname with a bypass-all
# Access application/policy, reusing this repo's own dotenv-provider and bypass-policy
# conventions verbatim (AGENTS.md, Public Access; spikes/00-aichatagent-basics/infra/main.tf).
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
  worker_name = "spike-01-ai-gateway-dynamic-routing"

  # This account's workers.dev subdomain, confirmed via
  # `GET /accounts/{account_id}/workers/subdomain` (Section 8 has no Terraform data source for
  # it and it is a stable, account-wide dashboard setting — not a per-worker resource — so it is
  # recorded here rather than looked up on every plan). Matches spikes/00-aichatagent-basics.
  workers_dev_subdomain = "adrian-hall-internal-demo"

  hostname = "${local.worker_name}.${local.workers_dev_subdomain}.workers.dev"

  # A short, spike-scoped AI Gateway id — this account's `cloudflare_ai_gateway.id` is a
  # user-chosen slug (not a generated UUID like a route's `id`), confirmed against the real
  # `default`/`demo-gateway` gateways already present in this account (`GET
  # /accounts/{account}/ai-gateway/gateways`). A dedicated gateway (rather than reusing the
  # account's pre-existing `demo-gateway`, which demo 5's/another exploration's own resources
  # already occupy) keeps this spike's teardown blast radius to exactly what it created.
  ai_gateway_id = "spike-01-dynroute"
}

# Bypass-all policy: this spike's own `probe.mjs`/curl needs to hit the endpoint directly with no
# Access authentication dance of its own to build (AGENTS.md, Public Access; Section 8).
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

# The AI Gateway itself. `authentication = false` matches the account's own pre-existing
# `demo-gateway` (a spike does not need a `cf-aig-authorization` header dance of its own to
# build); every other required field is set to the schema's documented "disabled" value (`0`)
# except where this spike deliberately exercises a real feature (`spend_limits`, below).
#
# `log_management`/`log_management_strategy`/`zdr`/`logpush` are all optional-but-not-computed in
# this resource's schema, yet the API silently fills in its own server-side defaults
# (`10000000`/`"DELETE_OLDEST"`/`false`/`false`) for any of them left unset. Terraform then reads
# those server-filled values back on the very next `terraform plan` and — because the config
# still says nothing, i.e. "should be null" — proposes removing them, forever. Every field the
# API is known to default must be pinned explicitly here, or `terraform plan` never reaches a
# clean, no-op state after the first apply. REPORT.md documents this class of drift in full.
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

  # Proves a gateway-level spend limit — one of the three node/config categories Spike B's aim
  # names — is Terraform-manageable. `metadata = { business = { mode = "partition" } }` (Section
  # 6, US-7's real shape) gives each distinct `business` metadata value its own $1/day budget
  # pool rather than one shared pool, exactly matching "different segments get different
  # cost/capability trade-offs" (docs/06-AGENTIC-CHAT.md, US-7).
  spend_limits = {
    enabled = true
    rules = [{
      limit_type = "cost"
      limit      = 1
      window     = 86400
      metadata = {
        business = {
          mode = "partition"
        }
      }
    }]
  }
}

# Route 1 — the simplest possible shape: start -> model -> end, no conditional. Proves the
# mechanical "governed route name replaces a literal model ID" chain (Section 6.3) with the
# fewest moving parts.
#
# A model node's `properties.provider` field (the raw JSON API shape confirmed by reading back
# this account's pre-existing `demo-gateway`/`actor-model-routing` route) is renamed
# `ai_gateway_dynamic_routing_provider` in this Terraform resource's HCL attribute — confirmed
# the hard way: the plain `provider` name is silently accepted by `terraform plan`'s schema
# validation (it is simply absent from both the plan diff and the applied state) but the
# resulting API call then fails with `400 { "path": ["...", "properties", "provider"],
# "message": "Required" }`, since the real key was never sent. REPORT.md documents this.
#
# `@cf/google/gemma-4-26b-a4b-it`, not demo 5's usual non-reasoning pick
# (`@cf/ibm-granite/granite-4.0-h-micro`), because REPORT.md's model-compatibility sweep found
# Granite (and five of seven other catalog models tried) fail every call routed through a dynamic
# route's "model" node specifically with `AiGatewayError 2002: Failed to parse model output` —
# reproducible independent of both the calling method (`env.AI.run()` binding vs. the plain REST
# endpoint) and metadata. This does not happen calling the same models directly (outside a
# dynamic route), so it is a property of the route's own model-node response adapter, not the
# model. Only `@cf/zai-org/glm-5.2`, `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`,
# `@cf/qwen/qwen2.5-coder-32b-instruct`, and `@cf/google/gemma-4-26b-a4b-it` were confirmed
# working in this sweep — Phase 4 MUST re-verify its chosen catalog against a real dynamic route
# before relying on it, not just against demo 5's already-verified-for-direct-calling catalog.
resource "cloudflare_ai_gateway_dynamic_routing" "basic" {
  account_id = local.cloudflare_account_id
  gateway_id = cloudflare_ai_gateway.spike.id
  name       = "spike-basic-route"

  elements = [
    {
      id   = "start"
      type = "start"
      outputs = {
        next = { element_id = "basic-model" }
      }
    },
    {
      id   = "basic-model"
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

  # This provider version's `Read` for this resource does not populate the top-level `elements`
  # attribute from the API's `GET .../routes/{id}` response at all (that response nests the same
  # data one level down, under `version.data`, not at `elements`) — confirmed by
  # `terraform state show` immediately after `apply` (elements present, from the create
  # response) versus the very next `terraform plan` (elements reads back empty, diffed against
  # config, and proposes `-/+ destroy and then create replacement` every single time with zero
  # config changes). `ignore_changes` is the correct, narrow workaround — identical in spirit to
  # the sanctioned bootstrap-deployment exception (AGENTS.md): a real provider limitation to
  # route around explicitly and revisit, not silently tolerate as normal `terraform plan` noise.
  # REPORT.md has the full before/after `terraform plan` output.
  lifecycle {
    ignore_changes = [elements]
  }
}

# Route 2 — the shape US-7 (metadata-driven routing) actually needs: a conditional node keyed on
# request metadata (`metadata.business`), each branch its own model, plus a rate-limit node on
# the "true" branch to also prove that node type is Terraform-manageable in the same apply.
# REPORT.md documents the conditional-expression syntax this required — `properties.conditions`
# is a Mongo-style query object (`{"metadata.<key>": {"$eq": "<value>"}}`), reverse-engineered
# from this account's own pre-existing, dashboard-authored `demo-gateway`/`actor-model-routing`
# route (`GET .../routes/{id}`) — and that the Terraform provider's own `conditions` attribute is
# typed as a plain `string`, not a nested object, so this HCL must `jsonencode()` it itself.
resource "cloudflare_ai_gateway_dynamic_routing" "governed" {
  account_id = local.cloudflare_account_id
  gateway_id = cloudflare_ai_gateway.spike.id
  name       = "spike-governed-route"

  elements = [
    {
      id   = "start"
      type = "start"
      outputs = {
        next = { element_id = "business-check" }
      }
    },
    {
      id   = "business-check"
      type = "conditional"
      properties = {
        conditions = jsonencode({
          "metadata.business" = { "$eq" = "leadership" }
        })
      }
      outputs = {
        true  = { element_id = "leadership-rate-gate" }
        false = { element_id = "basic-tier-model" }
      }
    },
    {
      id   = "leadership-rate-gate"
      type = "rate"
      properties = {
        key        = "metadata.business"
        limit      = 2
        limit_type = "count"
        window     = 60
      }
      outputs = {
        success  = { element_id = "reasoning-tier-model" }
        fallback = { element_id = "basic-tier-model" }
      }
    },
    {
      id   = "reasoning-tier-model"
      type = "model"
      properties = {
        model                               = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"
        ai_gateway_dynamic_routing_provider = "workers-ai"
        timeout                             = 60000
        retries                             = 1
      }
      outputs = {
        success  = { element_id = "end" }
        fallback = { element_id = "basic-tier-model" }
      }
    },
    {
      id   = "basic-tier-model"
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

  # Same provider limitation as `.basic` above — see that resource's comment.
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

output "basic_route_name" {
  value = cloudflare_ai_gateway_dynamic_routing.basic.name
}

output "governed_route_name" {
  value = cloudflare_ai_gateway_dynamic_routing.governed.name
}
