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

# The editor app shell (/app*), the owner-facing diagram API, and the admin API require
# authentication from any identity provider already configured on this account's Zero Trust team
# -- no Identity Provider is provisioned by Terraform (see docs/09-ARCHITECT.md's Decisions #2).
# Admin authorization is a separate, independent check the Worker performs against ADMIN_EMAIL --
# see src/worker/routes/me.ts (reports isAdmin to every identity) and
# src/worker/middleware/admin.ts (rejects every non-admin identity with 403 on /api/admin/*) --
# not a second Access policy.
resource "cloudflare_zero_trust_access_policy" "authenticated_users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} any authenticated user"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# Destinations are deliberately narrower than a bare "/api/*" wildcard: `/api/share/*` (the
# anonymous share-token resolver, `src/worker/routes/shares.ts`) is intentionally left off this
# list so it falls through to the "public" application above instead -- Access routes each
# request to the most specific matching application, and this application's own `domain` only
# ever matches `/app*` to begin with, so any destination not listed here is simply not covered by
# it. `/api/admin*` still requires an Access application to grant *any* authenticated identity
# through this far; the Worker's own `requireAdmin` middleware then narrows that down to exactly
# ADMIN_EMAIL. See docs/09-ARCHITECT.md's Access Model and `../src/access-policies.ts`'s matching
# `authenticate: false` carve-out used for local development.
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
      uri  = "${local.hostname}/api/me"
    },
    {
      type = "public"
      uri  = "${local.hostname}/api/diagrams*"
    },
    {
      type = "public"
      uri  = "${local.hostname}/api/admin*"
    }
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.authenticated_users.id
    precedence = 1
  }]
}
