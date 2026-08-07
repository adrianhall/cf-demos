resource "cloudflare_zero_trust_access_policy" "public" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} public access"
  decision   = "bypass"

  include = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "public" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} public"
  domain     = local.hostname
  type       = "self_hosted"

  destinations = [{ type = "public", uri = local.hostname }]
  policies     = [{ id = cloudflare_zero_trust_access_policy.public.id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_policy" "authenticated" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} authenticated editors"
  decision   = "allow"

  include = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "authenticated" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} editor"
  domain     = "${local.hostname}/app*"
  type       = "self_hosted"

  destinations = [
    { type = "public", uri = "${local.hostname}/app*" },
    { type = "public", uri = "${local.hostname}/api/*" },
  ]
  policies = [{ id = cloudflare_zero_trust_access_policy.authenticated.id, precedence = 1 }]
}
