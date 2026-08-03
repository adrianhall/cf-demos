# Minimal, spike-scoped Terraform (docs/06-AGENTIC-CHAT.md, Section 8). This account requires
# every Worker reachable over HTTPS — including a bare *.workers.dev URL — to sit behind a
# Cloudflare Access application. This spike needs a live `env.AI` call (Spike A's correction:
# `wrangler dev`'s remote-binding proxy for `env.AI` cannot complete on this account at all), so
# it deploys for real and drives it over its own public hostname, which per Section 8 MUST be
# fronted by a bypass-all Access application/policy, using this repo's own dotenv-provider and
# bypass-policy conventions verbatim (AGENTS.md, Public Access).
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22.0"
    }
    dotenv = {
      source  = "jrhouston/dotenv"
      version = "~> 1.0"
    }
  }
}

data "dotenv" "config" {
  filename = "${path.module}/../../../.env"
}

provider "cloudflare" {
  api_token = local.cloudflare_api_token
}

locals {
  cloudflare_api_token  = sensitive(data.dotenv.config.env["CLOUDFLARE_API_TOKEN"])
  cloudflare_account_id = data.dotenv.config.env["CLOUDFLARE_ACCOUNT_ID"]

  # The Worker's name, matching wrangler.jsonc's "name" field — Terraform does not own the Worker
  # resource itself for this spike (Wrangler owns the whole deploy, per Section 8's "reuse
  # whichever mechanism is simpler" guidance); Terraform only needs the name to build the
  # workers.dev hostname the Access application fronts.
  worker_name = "spike-05-workers-ai-speech-to-text"

  # This account's workers.dev subdomain, confirmed via
  # `GET /accounts/{account_id}/workers/subdomain` (Section 8 has no Terraform data source for
  # it and it is a stable, account-wide dashboard setting — not a per-worker resource — so it is
  # recorded here rather than looked up on every plan). Matches `spikes/00-aichatagent-basics`.
  workers_dev_subdomain = "adrian-hall-internal-demo"

  hostname = "${local.worker_name}.${local.workers_dev_subdomain}.workers.dev"
}

# Bypass-all policy: this spike's own probe script needs to hit the endpoint directly with no
# Access authentication dance of its own to build (AGENTS.md, Public Access;
# docs/06-AGENTIC-CHAT.md, Section 8).
resource "cloudflare_zero_trust_access_policy" "bypass" {
  account_id = local.cloudflare_account_id
  name       = "${local.worker_name} spike bypass"
  decision   = "bypass"

  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "spike" {
  account_id = local.cloudflare_account_id
  name       = local.worker_name
  domain     = local.hostname
  type       = "self_hosted"

  destinations = [{
    type = "public"
    uri  = local.hostname
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.bypass.id
    precedence = 1
  }]
}
