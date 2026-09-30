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

# Every demo in this repository shares one .env file at the repository root, so a
# single `pnpm create-env` run plus one API token configures all of them.
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

  # The demo owns its own name; the shared .env owns only the account and domain. So the Worker
  # name, database name, and hostname are all derived here rather than adding more shared keys.
  demo_name     = "vinext-chat"
  worker_name   = local.demo_name
  database_name = "${local.demo_name}-db"
  hostname      = "${local.demo_name}.${local.cloudflare_domain}"
}
