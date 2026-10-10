output "d1_database_id" {
  description = "D1 database identifier bound to the Worker as DB."
  value       = cloudflare_d1_database.demo.id
}

output "d1_database_name" {
  description = "D1 database name bound to the Worker as DB."
  value       = cloudflare_d1_database.demo.name
}

output "hostname" {
  description = "Public custom hostname for the SWAPI GraphQL service."
  value       = local.hostname
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
