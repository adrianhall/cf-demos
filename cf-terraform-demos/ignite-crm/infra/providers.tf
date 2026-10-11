terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
    dotenv = {
      source  = "jrhouston/dotenv"
      version = "~> 1.0"
    }
  }
}

# Every demo in this repository shares one .env file at the repository root, so a single
# `pnpm create-env` run plus one API token configures all of them.
data "dotenv" "config" {
  filename = "${path.module}/../../../.env"
}

provider "cloudflare" {
  api_token = local.cloudflare_api_token
}

locals {
  cloudflare_api_token   = sensitive(data.dotenv.config.env["CLOUDFLARE_API_TOKEN"])
  cloudflare_account_id  = data.dotenv.config.env["CLOUDFLARE_ACCOUNT_ID"]
  cloudflare_zone_id     = data.dotenv.config.env["CLOUDFLARE_ZONE_ID"]
  cloudflare_domain      = data.dotenv.config.env["CLOUDFLARE_DOMAIN"]
  cloudflare_team_domain = data.dotenv.config.env["CLOUDFLARE_TEAM_DOMAIN"]
  admin_email            = data.dotenv.config.env["ADMIN_EMAIL"]

  # The demo owns its own names; the shared .env owns only the account and domain.
  demo_name               = "ignite-crm"
  application_worker_name = "${local.demo_name}-application"
  data_worker_name        = "${local.demo_name}-data"
  database_name           = "${local.demo_name}-data"
  hostname                = "${local.demo_name}.${local.cloudflare_domain}"

  # Mirrors COMPATIBILITY_DATE and OBSERVABILITY in data/worker-settings.ts, so Terraform's
  # registrations and the cf deployments agree and neither reports drift.
  compatibility_date = "2026-10-07"
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
