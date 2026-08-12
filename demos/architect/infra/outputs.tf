output "access_audience" {
  description = "Application Audience (AUD) tag for the authenticated /app*+/api/* Access application, threaded into the Worker as the VITE_ACCESS_AUDIENCE build-time define (see package.json's deploy:worker:publish script and src/worker/middleware/access.ts)."
  value       = cloudflare_zero_trust_access_application.app.aud
}

output "admin_email" {
  description = "Sole identity the Worker's GET /api/me route compares the verified Cloudflare Access identity against to report isAdmin."
  value       = local.admin_email
}

output "ai_gateway_id" {
  description = "AI Gateway identifier fronting DiagramSession's env.AI.run() chat-turn calls, bound to the Worker as AI_GATEWAY_ID."
  value       = cloudflare_ai_gateway.demo.id
}

output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain for Worker JWT validation."
  value       = local.cloudflare_team_domain
}

output "d1_database_id" {
  description = "D1 database identifier bound to the Worker as DB in wrangler.jsonc."
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
  description = "Public custom hostname for the architecture diagram editor."
  value       = local.hostname
}

output "shares_kv_namespace_id" {
  description = "Workers KV namespace identifier for anonymous share-token lookups, bound to the Worker as SHARES."
  value       = cloudflare_workers_kv_namespace.shares.id
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
