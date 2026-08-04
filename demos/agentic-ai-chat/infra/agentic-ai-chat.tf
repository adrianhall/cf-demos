resource "cloudflare_worker" "demo" {
  account_id = local.cloudflare_account_id
  name       = local.worker_name

  # Matches this demo's wrangler.jsonc.tpl `workers_dev`/`preview_urls` settings exactly, so
  # Terraform and Wrangler agree on the subdomain and neither tool fights the other on plan.
  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  observability = {
    enabled = true
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 0.1
      persist            = true
    }
  }

  # Terraform destroys resources in reverse dependency order. This edge forces the Worker (and
  # its wrangler-managed D1/R2 bindings) to be destroyed before their backing resources, since
  # nothing in either resource's own arguments references the other. The AI Gateway/dynamic
  # routes below need no equivalent edge -- they are reached at runtime via `gateway: { id }` in
  # application code, not a wrangler.jsonc binding, so there is no Cloudflare API ordering
  # constraint between them and the Worker (AGENTS.md, Resource Ownership).
  depends_on = [cloudflare_d1_database.demo, cloudflare_r2_bucket.files]
}

resource "cloudflare_d1_database" "demo" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name}-db"

  read_replication = {
    mode = "disabled"
  }
}

# Agent-generated files (docs/06-AGENTIC-CHAT.md Phase 9, US-8) -- the first R2 use in this
# demo. Bound to the Worker as FILES; `ChatAgent`'s `writeMarkdown` tool is the only writer
# (AGENTS.md's R2 teardown convention -- `empty-r2-bucket` is wired into `package.json`'s
# `preteardown` step now that this resource exists).
resource "cloudflare_r2_bucket" "files" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name}-files"
}

# The AI Gateway itself. Every field the API is known to server-side-default is pinned
# explicitly (Spike B, spikes/01-ai-gateway-dynamic-routing/REPORT.md Section 1): leaving
# `log_management`/`log_management_strategy`/`zdr`/`logpush`/`authentication` unset lets the API
# silently fill in its own defaults, which this provider version's `Read` then reads back and
# proposes removing on every subsequent `plan` -- a real, previously-confirmed drift class, not
# hypothetical caution. `spend_limits` (Phase 8, US-7) partitions a $1/day cost budget by the same
# `business` metadata the two routes' conditional nodes below branch on -- each distinct business
# segment gets its own budget pool rather than one shared pool, the exact "cost controls" half of
# metadata-driven routing the backlog names (docs/06-AGENTIC-CHAT.md Section 6.6a, Phase 8 step
# 3): this limit is enforced against the very same authoritative per-request cost AI Gateway
# reports through `getLog()` that `chat_usage`/the admin console already display, not a second,
# independently-derived number. Shape confirmed live and Terraform-manageable by Spike B
# (`spikes/01-ai-gateway-dynamic-routing/infra/main.tf`).
resource "cloudflare_ai_gateway" "demo" {
  account_id                 = local.cloudflare_account_id
  id                         = local.demo_name
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

# The "basic" governed route (docs/06-AGENTIC-CHAT.md Section 6.3/6.1, US-3), extended by Phase 8
# (US-7) with a `business-check` conditional node: a caller whose `metadata.business` is exactly
# `"field"` resolves to the same cheap model this route always used; every other caller
# (`"product"`, `"leadership"`, or no business assigned yet) is gated by a rate-limit node keyed
# on `metadata.business` before reaching a stronger, more expensive model, falling back to the
# cheap model if that per-business-value rate limit is currently exceeded -- exactly the
# conditional -> rate -> model shape Spike B's own `spike-governed-route` proved live
# (`spikes/01-ai-gateway-dynamic-routing/REPORT.md` Section 3). `AI_GATEWAY_ROUTE_BASIC` (this
# route's real Cloudflare-assigned name, threaded to the Worker via outputs.tf/wrangler.jsonc.tpl)
# never changes shape from this restructuring -- only what happens *inside* the route does, so no
# application code outside `pricing.ts`'s own tier-aware estimate (Phase 8) needs to change.
# Every model below is one of the four confirmed working through a dynamic route's model node by
# Spike B's live sweep (spikes/01-ai-gateway-dynamic-routing/REPORT.md Section 4) -- most of demo
# 5's own verified-for-direct-calling catalog, including its usual non-reasoning pick
# (`@cf/ibm-granite/granite-4.0-h-micro`), fails every call routed through this element type with
# `AiGatewayError 2002: Failed to parse model output`.
resource "cloudflare_ai_gateway_dynamic_routing" "basic" {
  account_id = local.cloudflare_account_id
  gateway_id = cloudflare_ai_gateway.demo.id
  name       = "${local.demo_name}-basic"

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
        # `conditions` is a plain string attribute in this resource's HCL schema; the real
        # syntax underneath is a Mongo-style query object keyed by dotted metadata path, so HCL
        # must `jsonencode()` it itself (Spike B, Gotcha 2 -- confirmed live to actually steer
        # the resolved model, not just accepted by `apply`).
        conditions = jsonencode({
          "metadata.business" = { "$eq" = "field" }
        })
      }
      outputs = {
        true  = { element_id = "basic-field-model" }
        false = { element_id = "basic-rate-gate" }
      }
    },
    {
      id   = "basic-rate-gate"
      type = "rate"
      properties = {
        # Buckets the rate limit per distinct `business` value, exactly like Spike B's own
        # `leadership-rate-gate` element -- a burst on one business segment's strong-tier usage
        # falls back to the cheap model without affecting another segment's own budget.
        key        = "metadata.business"
        limit      = 3
        limit_type = "count"
        window     = 60
      }
      outputs = {
        success  = { element_id = "basic-strong-model" }
        fallback = { element_id = "basic-field-model" }
      }
    },
    {
      id   = "basic-field-model"
      type = "model"
      properties = {
        model = "@cf/google/gemma-4-26b-a4b-it"
        # The raw API's `properties.provider` field is renamed in this Terraform resource's HCL
        # schema -- using the plain `provider` name is silently dropped by `terraform plan` and
        # only fails later, at `apply`, with a confusing "provider is Required" API error. Spike
        # B, Gotcha 1.
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
      id   = "basic-strong-model"
      type = "model"
      properties = {
        model                               = "@cf/zai-org/glm-5.2"
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

  # This provider version's `Read` for this resource does not repopulate the top-level
  # `elements` attribute from the API at all (the read response nests the same data one level
  # down, under `version.data`) -- every `terraform plan` after the first `apply` otherwise
  # proposes destroying and recreating the route with zero config changes. A deliberate
  # `-replace` is required to actually change a route's shape later -- Spike B, Gotcha 4, and
  # exactly why this route's Phase 8 restructuring (adding `business-check`/`basic-rate-gate`/
  # `basic-strong-model`) needs `terraform apply
  # -replace=cloudflare_ai_gateway_dynamic_routing.basic` rather than a plain `apply` to actually
  # land against a previously-applied Phase 4 state.
  lifecycle {
    ignore_changes = [elements]
  }
}

# The "reasoning" governed route (US-3), extended by Phase 8 (US-7) with the same
# `business-check` -> rate-gate -> model shape as `.basic` above -- see that resource's comments
# for the full rationale, not repeated here. A `"field"` caller keeps resolving to a cheaper
# reasoning-adjacent model; every other caller is rate-gated (per business value) before reaching
# the stronger, pricier reasoning model this route always used.
resource "cloudflare_ai_gateway_dynamic_routing" "reasoning" {
  account_id = local.cloudflare_account_id
  gateway_id = cloudflare_ai_gateway.demo.id
  name       = "${local.demo_name}-reasoning"

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
          "metadata.business" = { "$eq" = "field" }
        })
      }
      outputs = {
        true  = { element_id = "reasoning-field-model" }
        false = { element_id = "reasoning-rate-gate" }
      }
    },
    {
      id   = "reasoning-rate-gate"
      type = "rate"
      properties = {
        key        = "metadata.business"
        limit      = 3
        limit_type = "count"
        window     = 60
      }
      outputs = {
        success  = { element_id = "reasoning-strong-model" }
        fallback = { element_id = "reasoning-field-model" }
      }
    },
    {
      id   = "reasoning-field-model"
      type = "model"
      properties = {
        model                               = "@cf/qwen/qwen2.5-coder-32b-instruct"
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
      id   = "reasoning-strong-model"
      type = "model"
      properties = {
        model                               = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"
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

  # Same provider limitation as `.basic` above -- see that resource's comment.
  lifecycle {
    ignore_changes = [elements]
  }
}

# Cloudflare rejects a custom domain attached to a Worker with zero deployments (error 100124).
# Terraform never manages the Worker's real code deployments (Wrangler owns those), so this
# placeholder version/deployment exists solely to give the Worker a first deployment to satisfy
# that API requirement. It is created once and then ignored forever via `ignore_changes`: every
# `wrangler deploy` creates its own new version and deployment that supersedes this placeholder,
# and Terraform never revisits or reverts that. See AGENTS.md (Resource Ownership).
resource "cloudflare_worker_version" "bootstrap" {
  account_id         = local.cloudflare_account_id
  worker_id          = cloudflare_worker.demo.id
  main_module        = "index.js"
  compatibility_date = "2026-08-03"

  modules = [{
    name         = "index.js"
    content_type = "application/javascript+module"
    content_base64 = base64encode(<<-JS
      export default {
        async fetch() {
          return new Response("Bootstrapping", { status: 503 });
        },
      };
    JS
    )
  }]

  lifecycle {
    ignore_changes = all
  }
}

resource "cloudflare_workers_deployment" "bootstrap" {
  account_id  = local.cloudflare_account_id
  script_name = cloudflare_worker.demo.name
  strategy    = "percentage"

  versions = [{
    version_id = cloudflare_worker_version.bootstrap.id
    percentage = 100
  }]

  lifecycle {
    ignore_changes = all
  }
}

resource "cloudflare_workers_custom_domain" "demo" {
  account_id = local.cloudflare_account_id
  hostname   = local.hostname
  service    = cloudflare_worker.demo.name
  zone_id    = local.cloudflare_zone_id

  depends_on = [cloudflare_workers_deployment.bootstrap]
}
