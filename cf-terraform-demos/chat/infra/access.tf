# Any identity from the team's configured identity providers is a legitimate participant, so the
# policy admits everyone who can authenticate. That is not the same as public access: `everyone`
# inside an `allow` decision still requires a completed login, unlike the `bypass` decision used
# for the public surface of the sibling `link` demo.
#
# This demo has no per-row ownership boundary the way `todo` does — every participant sees every
# channel and every message in it, which is what makes it a shared workspace. The boundary that
# matters here is *authorship*: a connected participant may only ever post as the identity pinned
# to their socket. That is enforced in src/worker/infrastructure/chat-room.ts, which reads the
# author from the socket attachment the Worker set and never from the incoming frame.
resource "cloudflare_zero_trust_access_policy" "users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} authenticated users"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# One application covering the whole hostname. There is no anonymous surface to carve out, so
# unlike the `link` demo there is no second, path-scoped public application alongside it.
#
# Covering the whole hostname also covers the WebSocket upgrade at
# `/api/channels/:channel/socket`: the browser opens a same-origin socket, so the upgrade request
# carries the same Access cookie as any other request and is challenged by the same application.
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
