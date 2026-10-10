output "ai_gateway_id" {
  description = "AI Gateway identifier bound to the Worker for every assistant inference call, so Logs and Analytics show its request cost in one place."
  value       = cloudflare_ai_gateway.demo.id
}

output "access_aud" {
  description = "Cloudflare Access Application Audience (AUD) tag the Worker validates the JWT `aud` claim against, so a token minted for a different Access application in the same team is rejected."
  value       = cloudflare_zero_trust_access_application.app.aud
}

output "admin_email" {
  description = "Sole identity the Worker treats as the administrator. Compared against the verified Access identity on every administrative route; there is no role column and no promote/demote flow."
  value       = data.dotenv.config.env["ADMIN_EMAIL"]
}

output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain used for Worker-side JWT validation."
  value       = local.cloudflare_team_domain
}

output "d1_database_id" {
  description = "D1 database identifier bound to the Worker as DB and targeted by remote migrations."
  value       = cloudflare_d1_database.demo.id
}

output "d1_database_name" {
  description = "D1 database name, used by the migration commands that address the database by name."
  value       = cloudflare_d1_database.demo.name
}

output "environment" {
  description = "Environment value bound into the Worker, selecting log transport and default severity."
  value       = "production"
}

output "hostname" {
  description = "Public custom hostname serving the demo, derived from the worker_name and hostname variables."
  value       = local.hostname
}

output "shares_kv_namespace_id" {
  description = "Workers KV namespace identifier for anonymous share-token digest lookups, bound to the Worker as SHARES."
  value       = cloudflare_workers_kv_namespace.shares.id
}

output "worker_name" {
  description = "Worker service name. Read by `pnpm teardown` so the delete step can never name a Worker this demo did not create."
  value       = cloudflare_worker.demo.name
}
