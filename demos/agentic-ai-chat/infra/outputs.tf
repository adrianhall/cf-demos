output "access_audience" {
  description = "Application Audience (AUD) tag for the whole-hostname Access application, threaded into the Worker as the VITE_ACCESS_AUDIENCE build-time define (see package.json's deploy:worker:publish script and src/worker/middleware/access.ts)."
  value       = cloudflare_zero_trust_access_application.demo.aud
}

output "admin_email" {
  description = "Identity idempotently promoted to this demo's D1-flagged administrator role on every sign-in, regardless of prior D1 state (docs/06-AGENTIC-CHAT.md Section 6.5)."
  value       = local.admin_email
}

output "ai_gateway_id" {
  description = "AI Gateway id bound at runtime via gateway: { id } in application code (not a wrangler.jsonc binding) from Phase 2 onward."
  value       = cloudflare_ai_gateway.demo.id
}

output "ai_gateway_route_basic" {
  description = "The 'basic' dynamic route's real Cloudflare-assigned name, bound to the Worker as the AI_GATEWAY_ROUTE_BASIC var (docs/06-AGENTIC-CHAT.md Phase 4, US-3) -- ChatAgent calls dynamic/<this value> through the AI_GATEWAY_ID gateway rather than hard-coding the route name in application code, so the two stay in sync if this resource is ever renamed."
  value       = cloudflare_ai_gateway_dynamic_routing.basic.name
}

output "ai_gateway_route_reasoning" {
  description = "The 'reasoning' dynamic route's real Cloudflare-assigned name, bound to the Worker as the AI_GATEWAY_ROUTE_REASONING var (docs/06-AGENTIC-CHAT.md Phase 4, US-3). See ai_gateway_route_basic's description."
  value       = cloudflare_ai_gateway_dynamic_routing.reasoning.name
}

output "cloudflare_account_id" {
  description = "Cloudflare account id, bound to the Worker as the CLOUDFLARE_ACCOUNT_ID var -- needed to build the AI Gateway logs-list REST URL ChatAgent.reconcileUsage() calls (docs/06-AGENTIC-CHAT.md Section 6.6; no binding lists logs). Not a secret on its own -- paired with the CLOUDFLARE_API_TOKEN Wrangler secret (see package.json's deploy:worker:secrets script), which is."
  value       = local.cloudflare_account_id
}

output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain for Worker JWT validation."
  value       = local.cloudflare_team_domain
}

output "d1_database_id" {
  description = "D1 database identifier bound to the Worker as DB in wrangler.jsonc, holding the users and chats directory."
  value       = cloudflare_d1_database.demo.id
}

output "d1_database_name" {
  description = "D1 database name bound to the Worker as DB in wrangler.jsonc."
  value       = cloudflare_d1_database.demo.name
}

output "environment" {
  description = "Worker ENVIRONMENT variable value for this deployment, resolved automatically by cloudflareLogger()."
  value       = "production"
}

output "hostname" {
  description = "Public custom hostname for the agentic chat demo."
  value       = local.hostname
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
