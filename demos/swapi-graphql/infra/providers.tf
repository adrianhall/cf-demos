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
  api_token = local.cloudflare_api_token
}

locals {
  cloudflare_api_token  = sensitive(data.dotenv.config.env["CLOUDFLARE_API_TOKEN"])
  cloudflare_account_id = data.dotenv.config.env["CLOUDFLARE_ACCOUNT_ID"]
  cloudflare_zone_id    = data.dotenv.config.env["CLOUDFLARE_ZONE_ID"]
  demo_domain           = data.dotenv.config.env["DEMO_DOMAIN"]
  demo_name             = data.dotenv.config.env["DEMO_NAME"]
  hostname              = "${local.demo_name}.${local.demo_domain}"
  worker_name           = local.demo_name
}
