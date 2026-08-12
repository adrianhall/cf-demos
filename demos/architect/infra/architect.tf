resource "cloudflare_worker" "demo" {
  account_id = local.cloudflare_account_id
  name       = local.worker_name

  # Matches this demo's wrangler.jsonc.tpl `workers_dev`/`preview_urls` settings exactly, so
  # Terraform and Wrangler agree on the subdomain and neither tool fights the other on plan.
  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  # `wrangler deploy` resets a Worker's observability metadata to disabled whenever
  # wrangler.jsonc.tpl carries no `observability` block of its own (confirmed against a real
  # deployment -- see docs/DECISIONS.md #24). Rather than run a second `terraform apply` after
  # every deploy to fix that drift back up, `wrangler.jsonc.tpl` carries its own `observability`
  # block that mirrors this one literally, value for value (see docs/DECISIONS.md #25) -- so
  # `wrangler deploy` reasserts the exact state Terraform already established instead of
  # resetting it. This resource remains the sole place these values are decided; change
  # `wrangler.jsonc.tpl`'s block to match any time this one changes.
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
  # its wrangler-managed D1/KV bindings) to be destroyed before the D1 database and KV namespace
  # themselves, since nothing in either resource's own arguments references the other. The AI
  # Gateway below needs no equivalent edge -- it is reached at runtime via `gateway: { id }` in
  # application code, not a wrangler.jsonc binding, so there is no Cloudflare API ordering
  # constraint between it and the Worker (AGENTS.md, Resource Ownership; matches
  # `demos/agentic-ai-chat`'s own identical precedent/comment for its own AI Gateway).
  depends_on = [
    cloudflare_d1_database.demo,
    cloudflare_workers_kv_namespace.shares,
  ]
}

resource "cloudflare_d1_database" "demo" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name}-db"

  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_workers_kv_namespace" "shares" {
  account_id = local.cloudflare_account_id
  title      = "${local.demo_name}-shares"
}

# The AI Gateway fronting docs/09D-ARCHITECT-AICHAT.md's `env.AI.run()` chat-turn calls inside
# `DiagramSession`. A plain gateway with no dynamic routing (unlike `demos/agentic-ai-chat`'s
# own AI Gateway) -- this demo has exactly one caller, one model, and no per-caller
# metadata-driven routing decision to make. Every field below is either `required` or
# `optional`-but-not-`computed` in the pinned provider's schema (confirmed by
# `terraform providers schema -json`, docs/DECISIONS.md #13/#35) -- leaving any of them unset
# either fails `plan` outright or causes perpetual drift as the API's own server-filled default
# is read back on every later `plan`.
resource "cloudflare_ai_gateway" "demo" {
  account_id                 = local.cloudflare_account_id
  id                         = "${local.demo_name}-ai"
  authentication             = false # only this Worker's own binding calls it
  cache_invalidate_on_update = true
  cache_ttl                  = 0 # chat responses are not cacheable
  collect_logs               = true
  logpush                    = false
  log_management             = 10000000
  log_management_strategy    = "DELETE_OLDEST"
  zdr                        = false
  rate_limiting_interval     = 60
  rate_limiting_limit        = 30 # coarse, gateway-wide demo-cost guard

  # A light, visible cost control for the presenter to point at in the dashboard -- not a
  # precisely-tuned production budget.
  spend_limits = {
    enabled = true
    rules = [{
      limit_type = "cost"
      limit      = 2
      window     = 86400
    }]
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
  compatibility_date = "2026-08-08"

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
