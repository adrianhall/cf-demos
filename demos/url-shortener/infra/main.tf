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

resource "cloudflare_workers_kv_namespace" "links" {
  account_id = local.cloudflare_account_id
  title      = "${local.demo_name}-links"
}

resource "cloudflare_workers_custom_domain" "demo" {
  account_id = local.cloudflare_account_id
  hostname   = local.hostname
  service    = cloudflare_worker.demo.name
  zone_id    = local.cloudflare_zone_id
}

resource "cloudflare_zero_trust_access_policy" "public_demo" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} public access"
  decision   = "bypass"

  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "public_demo" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} public"
  domain     = local.hostname
  type       = "self_hosted"

  destinations = [{
    type = "public"
    uri  = local.hostname
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.public_demo.id
    precedence = 1
  }]
}

resource "cloudflare_zero_trust_access_policy" "admin" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} administrator"
  decision   = "allow"

  include = [{
    email = {
      email = local.admin_email
    }
  }]
}

resource "cloudflare_zero_trust_access_application" "admin" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} administrator"
  domain     = "${local.hostname}/admin*"
  type       = "self_hosted"

  destinations = [
    {
      type = "public"
      uri  = "${local.hostname}/admin*"
    },
    {
      type = "public"
      uri  = "${local.hostname}/api/links*"
    }
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.admin.id
    precedence = 1
  }]
}
