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
  filename = "${path.module}/../../../.env"
}

provider "cloudflare" {
  api_token = data.dotenv.config.env["CLOUDFLARE_API_TOKEN"]
}

locals {
  cloudflare_account_id = data.dotenv.config.env["CLOUDFLARE_ACCOUNT_ID"]
  worker_name           = "spike-10-architect-workflow-20260807-a1f4c9"
  workers_dev_subdomain = "adrian-hall-internal-demo"
  hostname              = "${local.worker_name}.${local.workers_dev_subdomain}.workers.dev"
}
