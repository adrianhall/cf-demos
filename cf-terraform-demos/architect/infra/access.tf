# One hostname, two Access postures. The landing page, the blueprint gallery, the MCP connection
# guide and a read-only share link are genuinely public; the dashboard, the editor and every management API require a
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
    # The remote MCP endpoint (`../src/worker/routes/mcp.ts`), listed for the same reason as every
    # entry above: everything not enumerated here falls through to the hostname-wide bypass
    # application, so a path without an entry would be anonymously reachable at the edge. The entry
    # was added before the route existed, so the posture was already correct when the route
    # appeared rather than becoming correct afterwards.
    #
    # This wildcard matches a partial path segment: `/mcp*` also covers `/mcp-guide`. That is why
    # the public connection guide lives at `/guides/mcp` instead — see `../src/mcp-route.ts` and the
    # Access-posture contract in `../tests/worker/lifecycle.test.ts`. A guide under this prefix would
    # be challenged at the edge even though the Worker's stricter MCP policy regex left it public.
    {
      type = "public"
      uri  = "${local.hostname}/mcp*"
    }
  ]

  # Turns Access itself into the OAuth 2.1 authorization server a non-browser MCP client needs.
  # Without it, a client that cannot complete a browser login redirect is answered with a 302 it
  # can never follow, which surfaces as an unexplained connection failure rather than as an
  # authentication prompt.
  #
  # This is deliberately on the *existing* application rather than a second one. Access resolves
  # the most specific application for a request, so a second application covering `/mcp*` would
  # shadow this one and the two policy lists would then have to be kept in step by review. One
  # application means an identity that can sign in to the editor can sign in to the MCP endpoint,
  # and nobody else can — by construction rather than by agreement.
  #
  # The attribute is still documented as beta by the provider; see
  # specs/architect/03-mcp-spike.md §3 for the field set confirmed against the resolved provider
  # binary rather than against the registry documentation.
  oauth_configuration = {
    enabled = true

    # Dynamic Client Registration is the only registration mechanism Access offers: there is no
    # Client ID Metadata Documents field anywhere in the schema, and Access never advertises
    # support for it, so per the MCP specification's own client priority order even a fully
    # CIMD-capable client falls back to DCR here.
    #
    # The two loopback/localhost flags are not a lazier alternative to a narrow `allowed_uris`
    # list. `allowed_uris` requires an `https` URL, while OAuth 2.1's native-app loopback
    # exception means an agent harness redirects to a plain `http://127.0.0.1:…` address, so these
    # flags are the only mechanism that can admit such a client at all.
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_loopback  = true
      allow_any_on_localhost = true
    }

    # A short access token paired with a long grant session, which is Cloudflare's recommended
    # shape for an agent client and is load-bearing rather than a tuning preference: Access
    # re-evaluates policy on every silent refresh, so a revoked identity loses access within one
    # token lifetime instead of at its next interactive login.
    grant = {
      access_token_lifetime = "15m"
      session_duration      = "336h"
    }
  }

  policies = [{
    id         = cloudflare_zero_trust_access_policy.authenticated_users.id
    precedence = 1
  }]
}
