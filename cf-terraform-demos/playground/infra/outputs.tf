output "access_aud" {
  description = "Cloudflare Access Application Audience (AUD) tag the Worker validates the JWT `aud` claim against, so a token minted for a different Access application in the same team is rejected."
  value       = cloudflare_zero_trust_access_application.demo.aud
}

output "ai_gateway_id" {
  description = "Identifier of the AI Gateway every inference request must be routed through. Bound into the Worker as AI_GATEWAY_ID; the deployed Worker never falls back to the implicit `default` gateway."
  value       = cloudflare_ai_gateway.demo.id
}

output "cloudflare_account_id" {
  description = "Cloudflare account identifier, used to build the AI Gateway dashboard link shown on the Activity page."
  value       = local.cloudflare_account_id
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

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}

output "r2_bucket_name" {
  description = "Name of the R2 bucket Create Video stores generated video in. Bound into the Worker as VIDEO_BUCKET; emptied by `pnpm teardown` before the bucket is destroyed, since R2 refuses to delete a bucket that still holds objects."
  value       = cloudflare_r2_bucket.video.name
}
