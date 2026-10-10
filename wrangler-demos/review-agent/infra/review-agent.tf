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
  # wrangler.jsonc.tpl carries no `observability` block of its own (docs/DECISIONS.md #24).
  # Rather than run a second `terraform apply` after every deploy to fix that drift back up,
  # `wrangler.jsonc.tpl` carries its own `observability` block that mirrors this one literally,
  # value for value (docs/DECISIONS.md #25) -- so `wrangler deploy` reasserts the exact state
  # Terraform already established instead of resetting it. This resource remains the sole place
  # these values are decided; change `wrangler.jsonc.tpl`'s block to match any time this one
  # changes.
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
  # its wrangler-managed D1 binding) to be destroyed before the D1 database itself, since
  # nothing in either resource's own arguments references the other (AGENTS.md, Resource
  # Ownership). The AI Gateway resource below needs no equivalent edge: its id is a runtime
  # string argument the Worker reaches via `env.AI.gateway(id)`, not a compiled wrangler.jsonc
  # binding the Cloudflare API refuses to delete out from under a live Worker. Likewise, the
  # Durable Object (`ReviewRunAgent`) and Workflow (`ReviewPipelineWorkflow`) this Worker also
  # declares need no Terraform resource or `depends_on` edge at all: both are declared entirely
  # in wrangler.jsonc.tpl (a binding plus a `class_name`) and deployed by Wrangler, and are
  # removed along with the Worker script itself -- there is nothing product-specific here for
  # Terraform to provision or for teardown to clean up beyond deleting the Worker
  # (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 1, item 2).
  depends_on = [cloudflare_d1_database.demo]
}

resource "cloudflare_d1_database" "demo" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name}-db"

  read_replication = {
    mode = "disabled"
  }
}

# The AI Gateway itself, provisioned as its own named gateway rather than the account's
# `default` one, so its dashboard analytics stay scoped to this demo
# (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 1, item 2). Every field the API is known
# to server-side-default is pinned explicitly (docs/DECISIONS.md #13): leaving
# `log_management`/`log_management_strategy`/`zdr`/`logpush`/`authentication` unset lets the API
# silently fill in its own defaults, which this provider version's `Read` then reads back and
# proposes removing on every subsequent `plan`, forever. This demo never uses AI Gateway dynamic
# routing -- every reviewer call passes a literal model id, not a dynamic route name, so
# `env.AI.aiGatewayLogId` is populated normally (docs/DECISIONS.md #13/#16) -- so no
# `cloudflare_ai_gateway_dynamic_routing` resource or `spend_limits` rule is provisioned here.
resource "cloudflare_ai_gateway" "demo" {
  account_id                 = local.cloudflare_account_id
  id                         = "${local.demo_name}-gateway"
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
  compatibility_date = "2026-08-11"

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

# Two Access applications on one hostname (docs/07-PR-REVIEW-AGENT.md, "Access Model"), with the
# default and the exception inverted from AGENTS.md's canonical example (see "Explicit
# Exceptions"): every path is authenticated by default because triggering a review spends real
# AI Gateway budget, and only the two webhook paths -- which GitHub/GitLab call with no Access
# identity at all -- bypass Access entirely.

# The hostname-wide default: any authenticated identity may reach any path on this hostname. No
# email allowlist, matching demos/swapi-graphql's "Access is authentication, not
# application-level authorization" stance -- every signed-in user sees the same shared review
# history (docs/07-PR-REVIEW-AGENT.md, "Out Of Scope").
resource "cloudflare_zero_trust_access_policy" "demo" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} authenticated access"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "demo" {
  account_id = local.cloudflare_account_id
  name       = local.demo_name
  domain     = local.hostname
  type       = "self_hosted"

  policies = [{
    id         = cloudflare_zero_trust_access_policy.demo.id
    precedence = 1
  }]
}

# The exception: exactly the two webhook paths GitHub/GitLab call, scoped by `destinations` so
# Access routes these two exact paths to this more-specific application instead of the
# hostname-wide `allow` application above (AGENTS.md's "Access routes to the most specific
# matching application" rule). A `bypass` policy issues no Access identity JWT -- the real
# security boundary on these two paths is each provider's own signature/token verification
# inside the handler (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration"), not Access.
resource "cloudflare_zero_trust_access_policy" "webhooks" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} webhooks bypass"
  decision   = "bypass"

  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "webhooks" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} webhooks"
  # The Cloudflare API rejects a `destinations`-scoped application whose own `domain` value does
  # not literally match one of its `destinations` entries ("domain not included in destinations",
  # confirmed live against this account) -- `domain` must be one of the paths, not the bare
  # hostname, matching `demos/url-shortener`'s own already-working `admin` application's
  # convention of setting `domain` to its own first `destinations` entry.
  domain = "${local.hostname}/api/webhooks/github"
  type   = "self_hosted"

  destinations = [
    {
      type = "public"
      uri  = "${local.hostname}/api/webhooks/github"
    },
    {
      type = "public"
      uri  = "${local.hostname}/api/webhooks/gitlab"
    }
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.webhooks.id
    precedence = 1
  }]
}
