output "account_id" {
  description = "Cloudflare account identifier, read by the empty-r2-bucket preteardown CLI."
  value       = local.cloudflare_account_id
}

output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain used by the Worker to validate studio identities."
  value       = local.cloudflare_team_domain
}

output "d1_database_id" {
  description = "D1 database identifier bound as DB."
  value       = cloudflare_d1_database.media.id
}

output "d1_database_name" {
  description = "D1 database name bound as DB."
  value       = cloudflare_d1_database.media.name
}

output "environment" {
  description = "Production Worker environment used to configure structured logging."
  value       = "production"
}

output "hostname" {
  description = "Public custom hostname for Media Drop."
  value       = local.hostname
}

output "r2_bucket_name" {
  description = "R2 bucket name bound as MEDIA."
  value       = cloudflare_r2_bucket.media.name
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
