# Every participant must have a verified identity -- inference and personal chat history are
# both sensitive and billable, so there is no public bypass application, unlike a mixed
# public/admin demo. "Admin" is a D1 flag (users.is_admin), not a second Access application --
# see docs/06-AGENTIC-CHAT.md Section 6.5 and AGENTS.md's Public Access section.
resource "cloudflare_zero_trust_access_policy" "authenticated_users" {
  account_id = local.cloudflare_account_id
  name       = "${local.demo_name} any authenticated user"
  decision   = "allow"

  include = [{
    everyone = {}
  }]
}

# Access enforces this application at the edge, including SPA page routes served directly by the
# ASSETS binding and never reaching the Worker. `audience` (the application's own AUD tag,
# exposed below as the `access_audience` output) is threaded into the Worker as a Vite
# build-time define rather than a generated wrangler.jsonc var -- see
# src/worker/middleware/access.ts and package.json's `deploy:worker:publish` script -- so
# cloudflareAccess() can pin it and reject a token minted for any other Access application in
# this Cloudflare Access team.
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
