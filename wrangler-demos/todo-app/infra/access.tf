resource "cloudflare_zero_trust_access_policy" "authenticated_users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} any authenticated user"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# Access enforces this application at the edge, including SPA page routes that are served
# directly by the ASSETS binding and never reach the Worker.
resource "cloudflare_zero_trust_access_application" "demo" {
  account_id = local.cloudflare_account_id
  name       = local.demo_name
  domain     = local.hostname
  type       = "self_hosted"

  destinations = [{
    type = "public"
    uri  = local.hostname
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.authenticated_users.id
    precedence = 1
  }]
}
