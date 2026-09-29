output "admin_email" {
  description = "Administrator email the Worker checks the verified Cloudflare Access identity against, as defense-in-depth against cross-application Access token replay."
  value       = local.admin_email
}

output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain used for Worker-side JWT validation."
  value       = local.cloudflare_team_domain
}

output "environment" {
  description = "Environment value bound into the Worker, selecting log transport and default severity."
  value       = "production"
}

output "hostname" {
  description = "Public custom hostname serving the demo."
  value       = local.hostname
}

output "links_kv_namespace_id" {
  description = "Workers KV namespace identifier backing the link repository."
  value       = cloudflare_workers_kv_namespace.links.id
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
