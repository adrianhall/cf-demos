# The private Data Worker (ignite-crm-data) and the one D1 database it owns.
#
# Terraform registers the Worker and creates the database; `cf deploy` uploads code and attaches
# the DATA_DB binding. The Worker has no custom domain, no workers.dev subdomain, and no preview
# URLs: the Application Worker's DATA_SERVICE service binding is the only way to reach it.

resource "cloudflare_d1_database" "data" {
  account_id = local.cloudflare_account_id
  name       = local.database_name

  # Read replication would add eventually-consistent replicas. Every use case reads its own
  # writes (compare-and-swap versions, idempotency replay), so it stays disabled for release one.
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_worker" "data" {
  account_id = local.cloudflare_account_id
  name       = local.data_worker_name

  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  observability = local.observability

  # The DATA_DB binding is attached by cf, so Terraform cannot infer this edge. It forces the Worker
  # to be destroyed before the database it binds.
  depends_on = [cloudflare_d1_database.data]
}
