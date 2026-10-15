output "ai_gateway_id" {
  description = "Authenticated AI Gateway identifier reserved for SalesBot model calls."
  value       = cloudflare_ai_gateway.demo.id
}
output "access_aud" {
  description = "Access application audience validated by the Worker."
  value       = cloudflare_zero_trust_access_application.demo.aud
}
output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain used for JWT validation."
  value       = local.cloudflare_team_domain
}
output "d1_database_id" {
  description = "D1 identifier bound to the Worker and used by migrations."
  value       = cloudflare_d1_database.demo.id
}
output "d1_database_name" {
  description = "D1 database name used by migration commands."
  value       = cloudflare_d1_database.demo.name
}
output "environment" {
  description = "Deployed runtime environment name."
  value       = "production"
}
output "hostname" {
  description = "Public SalesBot hostname."
  value       = local.hostname
}
output "worker_name" {
  description = "SalesBot Worker service name."
  value       = cloudflare_worker.demo.name
}
