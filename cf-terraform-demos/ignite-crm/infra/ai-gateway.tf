# One observable, bounded-cost gateway for the chat assistant's Workers AI calls.
resource "cloudflare_ai_gateway" "chat" {
  account_id = local.cloudflare_account_id
  id         = "${local.demo_name}-chat"

  collect_logs               = true
  log_classification         = false
  log_management             = 10000
  log_management_strategy    = "DELETE_OLDEST"
  logpush                    = false
  cache_ttl                  = 0
  cache_invalidate_on_update = true
  rate_limiting_interval     = 60
  rate_limiting_limit        = 30
  rate_limiting_technique    = "sliding"
  # Require authenticated AI Gateway requests. The Workers AI binding supplies the
  # Worker-to-Gateway authentication when it routes through this gateway.
  authentication = true
  byok_only      = false
  # The Terraform provider calls Standard billing "postpaid".
  workers_ai_billing_mode = "postpaid"
  zdr                     = false

  spend_limits = {
    enabled = true
    rules = [{
      enabled    = true
      limit      = 2
      limit_type = "cost"
      technique  = "sliding"
      window     = 86400
    }]
  }
}
