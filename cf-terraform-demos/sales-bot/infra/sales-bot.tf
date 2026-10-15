resource "cloudflare_d1_database" "demo" {
  account_id       = local.cloudflare_account_id
  name             = local.database_name
  read_replication = { mode = "disabled" }
}

# Authentication is enabled before any Phase 3 model client exists, so an accidentally exposed
# gateway cannot be used anonymously. Postpaid is explicit: this demo bills Workers AI directly.
resource "cloudflare_ai_gateway" "demo" {
  account_id                 = local.cloudflare_account_id
  id                         = local.demo_name
  cache_invalidate_on_update = true
  cache_ttl                  = 0
  collect_logs               = true
  rate_limiting_interval     = 0
  rate_limiting_limit        = 0
  authentication             = true
  workers_ai_billing_mode    = "postpaid"
}

resource "cloudflare_worker" "demo" {
  account_id    = local.cloudflare_account_id
  name          = local.worker_name
  subdomain     = { enabled = false, previews_enabled = false }
  observability = { enabled = true, logs = { enabled = true, head_sampling_rate = 1, invocation_logs = true, persist = true }, traces = { enabled = true, head_sampling_rate = 0.1, persist = true } }
  depends_on    = [cloudflare_d1_database.demo, cloudflare_ai_gateway.demo]
}
resource "cloudflare_worker_version" "bootstrap" {
  account_id         = local.cloudflare_account_id
  worker_id          = cloudflare_worker.demo.id
  main_module        = "index.js"
  compatibility_date = "2026-10-13"
  modules            = [{ name = "index.js", content_type = "application/javascript+module", content_base64 = base64encode("export default { fetch() { return new Response('Bootstrapping', { status: 503 }); } };") }]
  lifecycle { ignore_changes = all }
}
resource "cloudflare_workers_deployment" "bootstrap" {
  account_id  = local.cloudflare_account_id
  script_name = cloudflare_worker.demo.name
  strategy    = "percentage"
  versions    = [{ version_id = cloudflare_worker_version.bootstrap.id, percentage = 100 }]
  lifecycle { ignore_changes = all }
}
resource "cloudflare_workers_custom_domain" "demo" {
  account_id = local.cloudflare_account_id
  hostname   = local.hostname
  service    = cloudflare_worker.demo.name
  zone_id    = local.cloudflare_zone_id
  depends_on = [cloudflare_workers_deployment.bootstrap]
}
