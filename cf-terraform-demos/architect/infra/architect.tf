resource "cloudflare_worker" "demo" {
  account_id = local.cloudflare_account_id
  name       = local.worker_name

  # Matches this demo's cloudflare.config.ts `workersDev`/`previewUrls` settings exactly, so
  # Terraform and the deploy tooling agree on the subdomain and neither fights the other on plan.
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

  # Terraform destroys resources in reverse dependency order. These edges force the Worker (and
  # its deploy-tooling-managed D1 and KV bindings) to be destroyed before the database and
  # namespace themselves, since nothing in either resource's own arguments references the other.
  # Without them, Cloudflare would refuse to delete storage that is still bound to a live Worker.
  depends_on = [
    cloudflare_ai_gateway.demo,
    cloudflare_d1_database.demo,
    cloudflare_workers_kv_namespace.shares
  ]
}

# The one durable copy of every diagram. Relational rather than KV because a diagram has an owner,
# a share lifecycle and (later) named collaborators, all of which are queried by predicate rather
# than fetched by a single known key.
resource "cloudflare_d1_database" "demo" {
  account_id = local.cloudflare_account_id
  name       = local.database_name

  # Read replication would add eventually-consistent replicas. The editor relies on
  # read-your-writes consistency — an autosave must be visible to the very next load — so it stays
  # disabled. Enable it for a read-heavy workload that tolerates replica lag.
  read_replication = {
    mode = "disabled"
  }
}

# A disposable fast lookup from a share token's SHA-256 digest to a diagram id, read on an
# anonymous request that has no identity to authorize and no relational query to run. D1 stays
# authoritative for the share lifecycle; losing this namespace costs a slower lookup, not data.
resource "cloudflare_workers_kv_namespace" "shares" {
  account_id = local.cloudflare_account_id
  title      = local.shares_kv_name
}

# Cloudflare rejects a custom domain attached to a Worker with zero deployments (error 100124).
# Terraform never manages the Worker's real code deployments (the deploy tooling owns those), so
# this placeholder version/deployment exists solely to give the Worker a first deployment to
# satisfy that API requirement. It is created once and then ignored forever via `ignore_changes`:
# every real deploy creates its own new version and deployment that supersedes this placeholder,
# and Terraform never revisits or reverts that.
resource "cloudflare_worker_version" "bootstrap" {
  account_id         = local.cloudflare_account_id
  worker_id          = cloudflare_worker.demo.id
  main_module        = "index.js"
  compatibility_date = "2026-08-25"

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
