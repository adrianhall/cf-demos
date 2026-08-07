resource "cloudflare_d1_database" "architect" {
  account_id = local.cloudflare_account_id
  name       = "${local.worker_name}-db"

  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_r2_bucket" "snapshots" {
  account_id = local.cloudflare_account_id
  name       = "${local.worker_name}-snapshots"
}

resource "cloudflare_workers_kv_namespace" "shares" {
  account_id = local.cloudflare_account_id
  title      = "${local.worker_name}-shares"
}

resource "cloudflare_worker" "demo" {
  depends_on = [
    cloudflare_d1_database.architect,
    cloudflare_r2_bucket.snapshots,
    cloudflare_workers_kv_namespace.shares,
  ]

  account_id = local.cloudflare_account_id
  name       = local.worker_name

  # This matches the generated Wrangler configuration and prevents perpetual plan drift.
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
}

# The custom-domain API needs one historical Worker deployment before it accepts the domain.
# Wrangler owns every real deployment; this inert bootstrap is permanently ignored afterward.
resource "cloudflare_worker_version" "bootstrap" {
  account_id         = local.cloudflare_account_id
  worker_id          = cloudflare_worker.demo.id
  main_module        = "index.js"
  compatibility_date = "2026-07-29"

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
