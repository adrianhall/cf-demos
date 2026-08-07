output "access_audience" {
  description = "Audience tag for the authenticated Access application, compiled into the Worker for JWT validation."
  value       = cloudflare_zero_trust_access_application.authenticated.aud
}

output "account_id" {
  description = "Cloudflare account identifier used by lifecycle helpers such as empty-r2-bucket."
  value       = local.cloudflare_account_id
}

output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain for Worker JWT validation."
  value       = local.cloudflare_team_domain
}

output "d1_database_id" {
  description = "D1 database identifier bound as DB."
  value       = cloudflare_d1_database.architect.id
}

output "d1_database_name" {
  description = "D1 database name bound as DB."
  value       = cloudflare_d1_database.architect.name
}

output "environment" {
  description = "Worker environment used by structured logging."
  value       = "production"
}

output "hostname" {
  description = "Public custom hostname for the architect demo."
  value       = local.hostname
}

output "r2_bucket_name" {
  description = "R2 bucket name bound as SNAPSHOTS."
  value       = cloudflare_r2_bucket.snapshots.name
}

output "shares_kv_namespace_id" {
  description = "KV namespace identifier bound as SHARES."
  value       = cloudflare_workers_kv_namespace.shares.id
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}

output "workflow_name" {
  description = "Architecture Workflow name configured by Wrangler."
  value       = "${local.worker_name}-architecture"
}
