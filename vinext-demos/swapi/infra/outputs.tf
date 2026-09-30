output "access_aud" {
  description = "Cloudflare Access Application Audience (AUD) tag the Worker validates the JWT `aud` claim against, so a token minted for a different Access application in the same team is rejected."
  value       = cloudflare_zero_trust_access_application.demo.aud
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
  description = "Public custom hostname serving the demo."
  value       = local.hostname
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
