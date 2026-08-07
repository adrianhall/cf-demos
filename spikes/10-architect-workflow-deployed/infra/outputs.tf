output "account_id" {
  description = "Cloudflare account identifier used by Wrangler."
  value       = local.cloudflare_account_id
}

output "worker_name" {
  description = "Unique Worker script name for this disposable spike."
  value       = cloudflare_worker.spike.name
}

output "worker_hostname" {
  description = "Access-bypassed workers.dev hostname used by the HTTP runner."
  value       = local.hostname
}

output "d1_database_id" {
  description = "D1 database identifier bound as DB."
  value       = cloudflare_d1_database.jobs.id
}

output "d1_database_name" {
  description = "D1 database name bound as DB."
  value       = cloudflare_d1_database.jobs.name
}

output "r2_bucket_name" {
  description = "R2 bucket name bound as PROPOSALS."
  value       = cloudflare_r2_bucket.proposals.name
}

output "workflow_name" {
  description = "Workflow name declared in Wrangler configuration."
  value       = "${local.worker_name}-architecture"
}
