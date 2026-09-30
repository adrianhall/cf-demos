# Any identity from the team's configured identity providers is a legitimate user of this demo and
# gets its own private task list, so the policy admits everyone who can authenticate. That is not
# the same as public access: `everyone` inside an `allow` decision still requires a completed login,
# unlike the `bypass` decision used for the public surface of the sibling `link` demo.
#
# The authorization boundary that actually matters in this app is per-row ownership, enforced by
# every SQL predicate in src/worker/infrastructure/d1-todo-repository.ts. This policy decides who
# may sign in; the repository decides whose tasks they can see.
resource "cloudflare_zero_trust_access_policy" "users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} authenticated users"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# One application covering the whole hostname. This demo has no anonymous surface, so unlike the
# `link` demo there is no second, path-scoped public application alongside it.
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
