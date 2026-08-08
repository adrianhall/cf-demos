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
  # deployment -- see docs/DECISIONS.md). `package.json`'s `deploy` script re-runs
  # `deploy:infra:reconcile` (a second `terraform apply`) after `deploy:worker` for exactly this
  # reason, so the final state after `npm run deploy` always has these settings applied, not just
  # the state immediately after the Terraform-only step.
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
  # themselves, since nothing in either resource's own arguments references the other.
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
