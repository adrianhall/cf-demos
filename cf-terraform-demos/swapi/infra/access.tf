# Any identity from the team's configured identity providers is a legitimate consumer of this
# read-only GraphQL API, so the policy admits everyone who can authenticate. That is not the same
# as public access: `everyone` inside an `allow` decision still requires a completed login, unlike
# the `bypass` decision used for the public surface of the sibling `link` demo.
#
# The data this API exposes is a fixed, public Star Wars dataset, so there is no per-identity
# authorization boundary to enforce below this policy — unlike the sibling `todo` demo, where
# per-row ownership is the point. What the login wall buys here is a bounded, attributable set of
# callers for an endpoint whose cost is caller-controlled: a GraphQL query can fan out across
# relations far more expensively than a REST read. Query cost is separately bounded in
# src/worker/application/schema-builder.ts.
resource "cloudflare_zero_trust_access_policy" "users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} authenticated users"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# One application covering the whole hostname, because every current surface (the GraphiQL console
# and the GraphQL endpoint it posts to) requires the same authenticated identity.
#
# The planned data editor will need a *stricter* rule than this one rather than a looser one, so it
# will arrive as a second, path-scoped application in front of its own mutation routes — following
# the pattern the `link` demo already demonstrates, where a more specific `/admin*` application
# sits on the same hostname as a broader one. Reads stay open to any authenticated identity; writes
# will be restricted to ADMIN_EMAIL. That is why this application is named for what it grants
# (authenticated read access) rather than being treated as the hostname's only rule.
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
    id         = cloudflare_zero_trust_access_policy.users.id
    precedence = 1
  }]
}
