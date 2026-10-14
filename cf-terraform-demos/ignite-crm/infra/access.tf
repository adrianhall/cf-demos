# Cloudflare Access authenticates every visitor at the edge; application RBAC decides what they may
# do. The policy therefore admits anyone who can authenticate against the team's identity
# providers (`everyone` inside `allow` still requires a completed login). An identity seen for the
# first time is provisioned as read-only by the Data Worker until an owner changes its role, so
# inviting a teammate needs no Terraform change. See specs/ignite-crm/03-follow-ons.md.
resource "cloudflare_zero_trust_access_policy" "users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} authenticated users"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# One application covering the whole hostname: the SPA, /api, and the reserved /mcp path. There is
# no anonymous surface. The Worker still verifies the Access JWT and its exact audience on every
# /api request (defence in depth).
resource "cloudflare_zero_trust_access_application" "application" {
  account_id = local.cloudflare_account_id
  name       = local.demo_name
  domain     = local.hostname
  type       = "self_hosted"

  # Access is the OAuth authorization server for non-browser MCP clients. The short-lived access
  # token causes Access policy to be re-evaluated on silent refresh.
  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_loopback  = true
      allow_any_on_localhost = true
    }
    grant = {
      access_token_lifetime = "15m"
      session_duration      = "336h"
    }
  }

  destinations = [{
    type = "public"
    uri  = local.hostname
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.users.id
    precedence = 1
  }]
}
