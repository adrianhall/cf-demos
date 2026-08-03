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
  # its wrangler-managed D1 binding) to be destroyed before the database itself, since nothing
  # in either resource's own arguments references the other. The AI Gateway/dynamic routes below
  # need no equivalent edge -- they are reached at runtime via `gateway: { id }` in application
  # code, not a wrangler.jsonc binding, so there is no Cloudflare API ordering constraint between
  # them and the Worker (AGENTS.md, Resource Ownership).
  depends_on = [cloudflare_d1_database.demo]
}

resource "cloudflare_d1_database" "demo" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name}-db"

  read_replication = {
    mode = "disabled"
  }
}

# The AI Gateway itself. Every field the API is known to server-side-default is pinned
# explicitly (Spike B, spikes/01-ai-gateway-dynamic-routing/REPORT.md Section 1): leaving
# `log_management`/`log_management_strategy`/`zdr`/`logpush`/`authentication` unset lets the API
# silently fill in its own defaults, which this provider version's `Read` then reads back and
# proposes removing on every subsequent `plan` -- a real, previously-confirmed drift class, not
# hypothetical caution. `spend_limits` is left unset here (optional *and* computed, so it does
# not drift) -- Phase 8 adds a real spend limit once metadata-driven routing exists to scope it
# by (docs/06-AGENTIC-CHAT.md, Phase 8).
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
}

# The "basic" governed route (docs/06-AGENTIC-CHAT.md Section 6.3/6.1, US-3). A single model
# node for now -- Phase 4 wires the client's route selector to call this route by name (its real
# name is threaded to the Worker as AI_GATEWAY_ROUTE_BASIC via outputs.tf/wrangler.jsonc.tpl,
# never hard-coded in application code); Phase 8 extends this same route with a
# business-metadata conditional node. The model is one of the four confirmed working through a
# dynamic route's model node by Spike B's live sweep
# (spikes/01-ai-gateway-dynamic-routing/REPORT.md Section 4) -- most of demo 5's own
# verified-for-direct-calling catalog, including its usual non-reasoning pick
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
        next = { element_id = "basic-model" }
      }
    },
    {
      id   = "basic-model"
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
      id      = "end"
      type    = "end"
      outputs = {}
    },
  ]

  # This provider version's `Read` for this resource does not repopulate the top-level
  # `elements` attribute from the API at all (the read response nests the same data one level
  # down, under `version.data`) -- every `terraform plan` after the first `apply` otherwise
  # proposes destroying and recreating the route with zero config changes. A deliberate
  # `-replace` is required to actually change a route's shape later. Spike B, Gotcha 4.
  lifecycle {
    ignore_changes = [elements]
  }
}

# The "reasoning" governed route (US-3). Same shape as `.basic` above, reasoning model.
resource "cloudflare_ai_gateway_dynamic_routing" "reasoning" {
  account_id = local.cloudflare_account_id
  gateway_id = cloudflare_ai_gateway.demo.id
  name       = "${local.demo_name}-reasoning"

  elements = [
    {
      id   = "start"
      type = "start"
      outputs = {
        next = { element_id = "reasoning-model" }
      }
    },
    {
      id   = "reasoning-model"
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
