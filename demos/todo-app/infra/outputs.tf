output "d1_database_id" {
  description = "D1 database identifier bound to the Worker as DB in wrangler.jsonc."
  value       = cloudflare_d1_database.demo.id
}

output "d1_database_name" {
  description = "D1 database name, also the positional argument `wrangler d1 migrations apply` expects."
  value       = cloudflare_d1_database.demo.name
}

output "environment" {
  description = "Worker ENVIRONMENT variable value for this deployment, resolved automatically by cloudflareLogger()."
  value       = "production"
}

output "hostname" {
  description = "Public custom hostname for the TODO app."
  value       = local.hostname
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
