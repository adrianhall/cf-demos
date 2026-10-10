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
    },
    {
      type = "public"
      uri  = "${local.hostname}/api/me*"
    }
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.admin.id
    precedence = 1
  }]
}
