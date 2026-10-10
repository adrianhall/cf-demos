resource "cloudflare_zero_trust_access_policy" "public" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} public access"
  decision   = "bypass"

  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "public" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} public library"
  domain     = local.hostname
  type       = "self_hosted"

  destinations = [{
    type = "public"
    uri  = local.hostname
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.public.id
    precedence = 1
  }]
}

resource "cloudflare_zero_trust_access_policy" "studio" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} studio creators"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "studio" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} studio"
  domain     = "${local.hostname}/studio*"
  type       = "self_hosted"

  destinations = [
    {
      type = "public"
      uri  = "${local.hostname}/studio*"
    },
    {
      type = "public"
      uri  = "${local.hostname}/api/studio*"
    }
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.studio.id
    precedence = 1
  }]
}
