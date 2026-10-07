terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
    dotenv = {
      source  = "jrhouston/dotenv"
      version = "~> 1.0"
    }
  }
}

# Every demo in this repository shares one .env file at the repository root, so a
# single `pnpm create-env` run plus one API token configures all of them.
data "dotenv" "config" {
  filename = "${path.module}/../../../.env"
}

provider "cloudflare" {
  api_token = local.cloudflare_api_token
}

# The Worker service name. Declared as a variable rather than a literal because this port is
# deployed *alongside* the implementation it was ported from, which still owns the shorter name
# on the same account. Every Worker, bootstrap, custom-hostname, Access and output resource below
# derives from this one value, and `pnpm teardown` resolves the name to delete from the
# `worker_name` output rather than restating it — so a stale literal can never make this demo's
# lifecycle commands reach the deployment it was ported from.
#
# Cutover (see specs/architect/01-specification.md §1.3) is therefore a single edit here, taken
# only once the source deployment's own name has been released.
variable "worker_name" {
  description = "Worker service name. Also seeds the D1 database name, KV namespace title, Access application names, and the default hostname."
  type        = string
  default     = "cf-architect"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,62}$", var.worker_name))
    error_message = "worker_name must be a lowercase DNS label: letters, digits and hyphens only."
  }
}

# The public custom hostname. Its initial value is written here, and only here, because this is the
# one place an operator changes at cutover; every resource, output, binding, script and document
# downstream derives from the variable rather than repeating the literal. The repository's naming
# contract explicitly permits this one default and rejects the same hostname anywhere else.
variable "hostname" {
  description = "Public custom hostname serving the demo. Change only this variable at cutover; every downstream consumer resolves the matching Terraform output."
  type        = string
  default     = "cf-architect.cfapps.uk"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", var.hostname))
    error_message = "hostname must be a lower-case DNS hostname."
  }
}

locals {
  cloudflare_api_token   = sensitive(data.dotenv.config.env["CLOUDFLARE_API_TOKEN"])
  cloudflare_account_id  = data.dotenv.config.env["CLOUDFLARE_ACCOUNT_ID"]
  cloudflare_zone_id     = data.dotenv.config.env["CLOUDFLARE_ZONE_ID"]
  cloudflare_domain      = data.dotenv.config.env["CLOUDFLARE_DOMAIN"]
  cloudflare_team_domain = data.dotenv.config.env["CLOUDFLARE_TEAM_DOMAIN"]

  # Everything nameable in this demo hangs off the two variables above.
  demo_name      = var.worker_name
  worker_name    = var.worker_name
  database_name  = "${var.worker_name}-db"
  shares_kv_name = "${var.worker_name}-shares"
  hostname       = var.hostname
}
