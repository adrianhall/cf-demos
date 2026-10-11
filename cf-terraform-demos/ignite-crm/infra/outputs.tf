output "access_aud" {
  description = "Cloudflare Access Application Audience (AUD) tag the Application Worker validates every JWT's aud claim against."
  value       = cloudflare_zero_trust_access_application.application.aud
}

output "admin_email" {
  description = "Repository-root ADMIN_EMAIL, bound into the Data Worker as the bootstrap owner identity."
  value       = local.admin_email
}

output "application_hostname" {
  description = "Public custom hostname serving the SPA and API."
  value       = cloudflare_workers_custom_domain.application.hostname
}

output "application_worker_name" {
  description = "Application Worker service name."
  value       = cloudflare_worker.application.name
}

output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain used for Worker-side JWT validation."
  value       = local.cloudflare_team_domain
}

output "d1_database_id" {
  description = "D1 database identifier read by the repository-root migration helper (same value as data_d1_database_id)."
  value       = cloudflare_d1_database.data.id
}

output "data_d1_database_id" {
  description = "D1 database identifier bound to the Data Worker as DATA_DB."
  value       = cloudflare_d1_database.data.id
}

output "data_d1_database_name" {
  description = "D1 database name."
  value       = cloudflare_d1_database.data.name
}

output "data_worker_name" {
  description = "Data Worker service name, the target of the Application Worker's DATA_SERVICE binding."
  value       = cloudflare_worker.data.name
}

output "environment" {
  description = "Environment value bound into both Workers, selecting production log transport and level."
  value       = "production"
}
