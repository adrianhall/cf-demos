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

  # Terraform destroys resources in reverse dependency order. This edge forces the Worker (and its
  # deploy-tooling-managed D1 binding) to be destroyed before the database itself, since nothing in
  # either resource's own arguments references the other. Without it, Cloudflare would refuse to
  # delete a database that is still bound to a live Worker.
  depends_on = [cloudflare_d1_database.demo]
}

resource "cloudflare_d1_database" "demo" {
  account_id = local.cloudflare_account_id
  name       = local.database_name

  # Read replication would add eventually-consistent replicas. The channel directory is read
  # immediately after it is written — creating a channel then joining it is one continuous user
  # action — so this demo relies on read-your-writes consistency and leaves replication disabled.
  read_replication = {
    mode = "disabled"
  }
}

# The `ChatRoom` Durable Object namespace has no Terraform resource on purpose. A Durable Object
# namespace is not independent infrastructure: it is declared by the Worker that defines the class
# (`exports.durableObject` in ../cloudflare.config.ts) and is provisioned and retired by `cf deploy`
# together with the code that implements it. Terraform owning it as well would violate this
# repository's one-owner-per-resource rule and would let a `terraform destroy` orphan the class or
# an ordinary deploy show as drift. Deleting the Worker in `pnpm teardown:worker` removes the
# namespace and every channel's stored history with it.

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
