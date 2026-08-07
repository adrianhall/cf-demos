resource "cloudflare_d1_database" "jobs" {
  account_id = local.cloudflare_account_id
  name       = "${local.worker_name}-jobs"

  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_r2_bucket" "proposals" {
  account_id = local.cloudflare_account_id
  name       = "${local.worker_name}-proposals"
}

resource "cloudflare_worker" "spike" {
  depends_on = [
    cloudflare_d1_database.jobs,
    cloudflare_r2_bucket.proposals,
  ]

  account_id = local.cloudflare_account_id
  name       = local.worker_name

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
      head_sampling_rate = 1
      persist            = true
    }
  }

  subdomain = {
    enabled          = true
    previews_enabled = false
  }
}
