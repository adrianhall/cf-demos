# The AI Gateway every inference request in this demo must travel through.
#
# It is declared here, with an explicit ID, rather than relying on AI Gateway's implicit `default`
# gateway. A `default` gateway is created on first use and is shared by everything in the account,
# so it could not be destroyed by `pnpm teardown` without affecting unrelated work, and its
# settings would be whatever some other application last chose. Owning the gateway here makes its
# configuration reviewable, its lifecycle complete, and the demo's cost figures attributable to
# this demo alone.
#
# Every field the provider exposes is set explicitly, including the ones whose defaults would
# otherwise be acceptable. The AI Gateway API fills unset values server-side, which shows up as
# perpetual Terraform drift on the next plan; writing them down also makes the privacy posture a
# reviewable decision rather than an accident.
resource "cloudflare_ai_gateway" "demo" {
  account_id = local.cloudflare_account_id
  id         = local.gateway_id

  # Logs are the entire point of routing through a gateway here: the demo reads cost, token usage,
  # cache state, and duration back out of them with `env.AI.gateway(id).getLog(logId)`. Turning
  # this off would leave every panel showing "Unavailable" for cost.
  collect_logs = true

  # The demo asks for metadata-only logging by sending `cf-aig-collect-log-payload: false` per
  # request (see the inference client). That is good practice, not a guarantee the application can
  # make on a visitor's behalf: payload retention is the gateway's behaviour, the AI binding exposes
  # no payload-collection option so the request travels as an extra header, and AI Gateway documents
  # that a log can include the prompt and response. The panels therefore tell visitors to assume
  # their prompt is logged rather than promising otherwise.
  #
  # The verified user email is attached as custom metadata, which is the identifying field this demo
  # deliberately keeps and states plainly in the UI before anything is submitted.
  log_management          = 10000
  log_management_strategy = "DELETE_OLDEST"
  # Classification would have Cloudflare process stored prompts and responses to categorise them.
  # This demo stores no payloads and makes no claim about where its users' prompts may be analysed,
  # so it stays off.
  log_classification = false
  logpush            = false

  # Caching is demonstrated rather than merely enabled: re-running an identical prompt should show
  # a cache hit with no new provider charge, which is one of the clearest reasons to put a gateway
  # in front of a model. One hour is long enough to survive a presentation and short enough that a
  # returning visitor still sees live inference.
  cache_ttl                  = 3600
  cache_invalidate_on_update = false

  # A playground invites experimentation, including accidental loops in a browser tab. A sliding
  # 100-requests-per-minute window bounds the damage without interrupting a human demonstration.
  rate_limiting_limit     = 100
  rate_limiting_interval  = 60
  rate_limiting_technique = "sliding"

  # Authenticated gateway: every request must carry a valid Cloudflare API token.
  #
  # This closes a real hole. A gateway's provider-native endpoint is reachable from the internet by
  # anyone who learns the account ID and this gateway's name, and with authentication off such a
  # request *succeeds* — spending this account's inference credit and inflating the log store that
  # the demo's own cost figures are read from. Neither Cloudflare Access nor the Worker's own
  # authorization protects that path, because it never touches the Worker.
  #
  # It costs this demo nothing, which is why the earlier "second secret to manage" reasoning was
  # wrong: requests reaching a gateway through a Worker's AI binding are pre-authenticated by the
  # account that owns both, so no token has to be minted, stored, or rotated for the binding to
  # keep working. See
  # https://developers.cloudflare.com/ai-gateway/configuration/authentication/#expected-behavior.
  #
  # The trade-off is deliberate and worth stating: with this on, a `curl` against the gateway's
  # provider endpoint needs a token with `AI Gateway Run`. That is the point.
  authentication = true

  # Third-party catalog models bill through Unified Billing with Cloudflare-managed credentials, so
  # the demo works without the presenter holding provider API keys. `byok_only` would require them.
  byok_only = false
  zdr       = false

  # A transient provider error should not look to a visitor like a broken panel. Two extra attempts
  # with exponential backoff absorb a blip; more than that would make a failure feel like a hang.
  retry_max_attempts = 3
  retry_delay        = 1000
  retry_backoff      = "exponential"
}

resource "cloudflare_worker" "demo" {
  account_id = local.cloudflare_account_id
  name       = local.worker_name

  # Matches this demo's cloudflare.config.ts `workersDev`/`previewUrls` settings exactly, so
  # Terraform and the deploy tooling agree on the subdomain and neither fights the other on plan.
  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  observability = {
    enabled = true
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 0.1
      persist            = true
    }
  }

  # Terraform destroys resources in reverse dependency order. This edge forces the Worker — and the
  # `AI` binding that `cf` attaches to it at deploy time — to be destroyed before the gateway
  # itself, since neither resource's own arguments reference the other. `cf` owns the binding, so
  # Terraform cannot infer the dependency and would otherwise be free to delete a gateway that a
  # live Worker is still sending inference through.
  depends_on = [cloudflare_ai_gateway.demo]
}

# Cloudflare rejects a custom domain attached to a Worker with zero deployments (error 100124).
# Terraform never manages the Worker's real code deployments (the deploy tooling owns those), so
# this placeholder version/deployment exists solely to give the Worker a first deployment to
# satisfy that API requirement. It is created once and then ignored forever via `ignore_changes`:
# every real deploy creates its own new version and deployment that supersedes this placeholder,
# and Terraform never revisits or reverts that.
resource "cloudflare_worker_version" "bootstrap" {
  account_id         = local.cloudflare_account_id
  worker_id          = cloudflare_worker.demo.id
  main_module        = "index.js"
  compatibility_date = "2026-08-25"

  modules = [{
    name         = "index.js"
    content_type = "application/javascript+module"
    content_base64 = base64encode(<<-JS
      export default {
        async fetch() {
          return new Response("Bootstrapping", { status: 503 });
        },
      };
    JS
    )
  }]

  lifecycle {
    ignore_changes = all
  }
}

resource "cloudflare_workers_deployment" "bootstrap" {
  account_id  = local.cloudflare_account_id
  script_name = cloudflare_worker.demo.name
  strategy    = "percentage"

  versions = [{
    version_id = cloudflare_worker_version.bootstrap.id
    percentage = 100
  }]

  lifecycle {
    ignore_changes = all
  }
}

resource "cloudflare_workers_custom_domain" "demo" {
  account_id = local.cloudflare_account_id
  hostname   = local.hostname
  service    = cloudflare_worker.demo.name
  zone_id    = local.cloudflare_zone_id

  depends_on = [cloudflare_workers_deployment.bootstrap]
}
