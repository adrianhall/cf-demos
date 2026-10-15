terraform {
  required_version = ">= 1.10.0"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.22" }
    dotenv     = { source = "jrhouston/dotenv", version = "~> 1.0" }
  }
}
data "dotenv" "config" { filename = "${path.module}/../../../.env" }
provider "cloudflare" { api_token = local.cloudflare_api_token }
locals {
  cloudflare_api_token   = sensitive(data.dotenv.config.env["CLOUDFLARE_API_TOKEN"])
  cloudflare_account_id  = data.dotenv.config.env["CLOUDFLARE_ACCOUNT_ID"]
  cloudflare_zone_id     = data.dotenv.config.env["CLOUDFLARE_ZONE_ID"]
  cloudflare_domain      = data.dotenv.config.env["CLOUDFLARE_DOMAIN"]
  cloudflare_team_domain = data.dotenv.config.env["CLOUDFLARE_TEAM_DOMAIN"]
  demo_name              = "sales-bot"
  worker_name            = local.demo_name
  database_name          = "${local.demo_name}-db"
  hostname               = "${local.demo_name}.${local.cloudflare_domain}"
}
