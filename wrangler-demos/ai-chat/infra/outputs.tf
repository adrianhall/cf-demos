output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain for Worker JWT validation."
  value       = local.cloudflare_team_domain
}

output "environment" {
  description = "Worker ENVIRONMENT variable value for this deployment, resolved automatically by cloudflareLogger()."
  value       = "production"
}

output "hostname" {
  description = "Public custom hostname for the AI model playground."
  value       = local.hostname
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
