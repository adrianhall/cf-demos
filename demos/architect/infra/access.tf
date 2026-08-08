# The landing page, /blueprints, and the read-only share viewer are public. See
# docs/09-ARCHITECT.md's Access Model.
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
  name       = "${local.demo_name} public"
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

# The editor app shell (/app*) and every API route require authentication from any identity
# provider already configured on this account's Zero Trust team -- no Identity Provider is
# provisioned by Terraform (see docs/09-ARCHITECT.md's Decisions #2). Admin authorization is a
# separate, independent check the Worker performs against ADMIN_EMAIL -- see
# src/worker/routes/me.ts -- not a second Access policy.
resource "cloudflare_zero_trust_access_policy" "authenticated_users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} any authenticated user"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "app" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} app"
  domain     = "${local.hostname}/app*"
  type       = "self_hosted"

  destinations = [
    {
      type = "public"
      uri  = "${local.hostname}/app*"
    },
    {
      type = "public"
      uri  = "${local.hostname}/api/*"
    }
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.authenticated_users.id
    precedence = 1
  }]
}
