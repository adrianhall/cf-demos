# The public Application Worker (ignite-crm-application): SPA assets plus the /api surface, served
# on ignite-crm.<CLOUDFLARE_DOMAIN>.

resource "cloudflare_worker" "application" {
  account_id = local.cloudflare_account_id
  name       = local.application_worker_name

  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  observability = local.observability

  # The DATA_SERVICE service binding is attached by cf. This edge destroys the Application Worker
  # before the Data Worker it binds.
  depends_on = [cloudflare_worker.data]
}

# Cloudflare rejects a custom domain for a Worker that has never been deployed. This placeholder
# version/deployment gives the Worker a first deployment; every real `cf deploy` supersedes it, and
# `ignore_changes = all` keeps Terraform from ever reverting that.
resource "cloudflare_worker_version" "application_bootstrap" {
  account_id         = local.cloudflare_account_id
  worker_id          = cloudflare_worker.application.id
  main_module        = "index.js"
  compatibility_date = local.compatibility_date

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

resource "cloudflare_workers_deployment" "application_bootstrap" {
  account_id  = local.cloudflare_account_id
  script_name = cloudflare_worker.application.name
  strategy    = "percentage"

  versions = [{
    version_id = cloudflare_worker_version.application_bootstrap.id
    percentage = 100
  }]

  lifecycle {
    ignore_changes = all
  }
}

resource "cloudflare_workers_custom_domain" "application" {
  account_id = local.cloudflare_account_id
  hostname   = local.hostname
  service    = cloudflare_worker.application.name
  zone_id    = local.cloudflare_zone_id

  depends_on = [cloudflare_workers_deployment.application_bootstrap]
}
