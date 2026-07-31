# Inference is billable compute, so no route in this demo may be anonymous. The whole
# ai-chat.cfapps.uk hostname requires authentication through a configured identity provider —
# there is no public bypass application, following demos/chat. See AGENTS.md (Public Access) and
# docs/05-AI-CHAT.md (Access Model).
resource "cloudflare_zero_trust_access_policy" "authenticated_users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} any authenticated user"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# Access enforces this application at the edge, including the SPA shell served directly by the
# ASSETS binding, which never reaches the Worker.
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
