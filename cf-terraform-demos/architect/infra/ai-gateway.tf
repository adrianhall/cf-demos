# One observable, bounded-cost gateway for the assistant's Workers AI calls. Every required and
# optional+computed provider field is pinned explicitly: omitting an optional+computed field lets
# the API choose it, which Terraform then reads back as drift on every plan.
resource "cloudflare_ai_gateway" "demo" {
  account_id = local.cloudflare_account_id
  id         = "${local.worker_name}-chat"

  # The presenter looks at this gateway's Logs / Analytics view to see requests, tokens, errors and
  # cost. The Worker's own structured logs deliberately contain no prompt or response content.
  collect_logs = true

  # Keep only a modest rolling log set. Classification would process stored content to categorize
  # it, a capability this demo neither needs nor claims to provide.
  log_classification      = false
  log_management          = 10000
  log_management_strategy = "DELETE_OLDEST"
  logpush                 = false

  # Tool-calling chat turns are stateful: replaying a cached round would repeat stale prose or skip
  # a mutation. Cache nothing, and invalidate any prior entry if this configuration changes.
  cache_ttl                  = 0
  cache_invalidate_on_update = true

  # A presentation should remain useful under accidental retries without allowing an unattended
  # tab to issue unbounded calls. State the algorithm as well as the limit, so its behaviour is
  # readable from this file rather than hidden in a provider default.
  rate_limiting_interval  = 60
  rate_limiting_limit     = 30
  rate_limiting_technique = "sliding"

  # Require authenticated AI Gateway requests. The sole caller is this Worker's account-bound AI
  # binding, which supplies the Worker-to-Gateway authentication when it routes through the gateway.
  authentication = true

  # Use Cloudflare-managed provider credentials, retain no customer-provided key requirement, and
  # use Standard billing. The provider calls Standard billing "postpaid".
  byok_only               = false
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
