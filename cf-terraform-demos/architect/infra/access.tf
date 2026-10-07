# One hostname, two Access postures. The landing page, the blueprint gallery and a read-only
# share link are genuinely public; the dashboard, the editor and every management API require a
# verified identity. Cloudflare Access resolves that by matching the *most specific* application
# for a request, so the pair below is ordered by specificity, not by precedence: the hostname-wide
# bypass is the fallback, and the path-scoped authenticated application in front of it covers only
# the paths that must challenge.

# ---------------------------------------------------------------------------------------------
# Public posture
# ---------------------------------------------------------------------------------------------

# `bypass` rather than an `allow` decision naming everyone: an `allow` for `everyone` still
# requires a completed login, which is exactly what a public landing page must not do.
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

# ---------------------------------------------------------------------------------------------
# Authenticated posture
# ---------------------------------------------------------------------------------------------

# Any identity the account's Zero Trust team already knows is a legitimate user: each one gets
# their own diagrams. No identity provider is provisioned here.
#
# Administrator authorization is deliberately *not* a second policy. Access answers "who is this";
# the Worker answers "what may they do" by comparing the verified email to its ADMIN_EMAIL
# variable on every admin route. Encoding the administrator here instead would mean the
# application could not re-check it as defence in depth.
resource "cloudflare_zero_trust_access_policy" "authenticated_users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} any authenticated user"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# The destination list is deliberately an enumeration rather than a bare `/api/*` wildcard. The
# anonymous share resolver lives under `/api/` like everything else but must stay public, so it is
# simply left off this list and falls through to the hostname-wide bypass application above. That
# omission is the whole mechanism — there is no "public" entry to write, and adding `/api/*` here
# would silently take the share resolver private.
#
# Mirrored by `../src/access-policies.ts`, which the Worker and the local Access emulation both
# evaluate. A path that authenticates in one place and not the other breaks a visibly different
# thing in each, so the two lists are reviewed together.
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
    # `/api/health` is deliberately absent alongside the anonymous share resolver below: a
    # liveness probe that requires a verified identity cannot answer whether the deployment is
    # serving traffic when authentication itself is the thing that is broken. Both fall through to
    # the hostname-wide bypass application above.
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
    },
    # Reserved for the later MCP phase, and listed now for the same reason `../src/access-policies
    # .ts` lists it: everything not enumerated here falls through to the hostname-wide bypass
    # application above, so a path added later without an entry would be anonymously reachable at
    # the edge. Declaring it here means the posture is already correct when the route appears, and
    # a request to it today is challenged and then answered with this Worker's 404 — which is the
    # right answer for a route that does not exist yet.
    {
      type = "public"
      uri  = "${local.hostname}/mcp*"
    }
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.authenticated_users.id
    precedence = 1
  }]
}
