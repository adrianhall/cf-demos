terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22.0"
    }
    dotenv = {
      source  = "jrhouston/dotenv"
      version = "~> 1.0"
    }
  }
}

data "dotenv" "config" {
  filename = "${path.module}/../.env"
}

provider "cloudflare" {
  api_token = data.dotenv.config.env["CLOUDFLARE_API_TOKEN"]
}

locals {
  hostname    = "${local.demo_name}.${local.demo_domain}"
  worker_name = local.demo_name
}

resource "cloudflare_worker" "demo" {
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
      head_sampling_rate = 0.1
      persist            = true
    }
  }
}

resource "cloudflare_d1_database" "media" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name}-db"

  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_r2_bucket" "media" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name}-store"
}

# A custom domain requires a Worker deployment. Wrangler owns all real deployments, so this
# immutable placeholder only satisfies the first-apply ordering requirement.
resource "cloudflare_worker_version" "bootstrap" {
  account_id         = local.cloudflare_account_id
  worker_id          = cloudflare_worker.demo.id
  main_module        = "index.js"
  compatibility_date = "2026-07-27"

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
