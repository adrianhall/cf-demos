output "admin_email" {
  description = "Administrator email the Worker's /api/me route checks the verified Cloudflare Access identity against, as defense-in-depth against cross-application Access token replay."
  value       = local.admin_email
}

output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain for Worker JWT validation."
  value       = local.cloudflare_team_domain
}

output "environment" {
  description = "Worker ENVIRONMENT variable value for this deployment, used by src/worker/middleware/logger.ts to select log transport and default severity."
  value       = "production"
}

output "hostname" {
  description = "Public custom hostname for the URL shortener."
  value       = local.hostname
}

output "links_kv_namespace_id" {
  description = "Workers KV namespace identifier for short links."
  value       = cloudflare_workers_kv_namespace.links.id
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
