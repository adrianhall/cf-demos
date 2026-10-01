# Anyone who can authenticate against the team's configured identity providers is a legitimate user
# of this demo, so the policy admits everyone who can sign in. That is not the same as public
# access: `everyone` inside an `allow` decision still requires a completed login, unlike the
# `bypass` decision a public surface would use. There is deliberately no application-level email
# allowlist — the demo exists to be handed to a colleague and tried.
#
# Authentication is nonetheless load-bearing rather than decorative. Every inference request records
# the verified email in AI Gateway metadata (see
# ../src/worker/infrastructure/ai/gateway-inference-client.ts), so gateway logs, analytics, and cost
# are attributable to the person who caused them. An anonymous playground would make that
# impossible.
resource "cloudflare_zero_trust_access_policy" "users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} authenticated users"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# One application covering the whole hostname. The playground has no anonymous surface at all: both
# the single-page application and `/api/*` sit behind this one Access application, so there is no
# second, path-scoped public application alongside it.
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
