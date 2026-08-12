output "ai_gateway_id" {
  description = "AI Gateway id bound to the Worker as the AI_GATEWAY_ID var, read at runtime via env.AI.gateway(id) (not a wrangler.jsonc binding)."
  value       = cloudflare_ai_gateway.demo.id
}

output "cloudflare_team_domain" {
  description = "Cloudflare Access team domain for Worker JWT validation, bound ahead of Phase 2 so wrangler.jsonc.tpl never needs a second Terraform-sourced var added later."
  value       = local.cloudflare_team_domain
}

output "d1_database_id" {
  description = "D1 database identifier bound to the Worker as DB in wrangler.jsonc, holding the review run/reviewer/finding tables from docs/07-PR-REVIEW-AGENT.md's Data Model section."
  value       = cloudflare_d1_database.demo.id
}

output "d1_database_name" {
  description = "D1 database name bound to the Worker as DB in wrangler.jsonc."
  value       = cloudflare_d1_database.demo.name
}

output "environment" {
  description = "Worker ENVIRONMENT variable value for this deployment, resolved automatically by cloudflareLogger()."
  value       = "production"
}

output "hostname" {
  description = "Public custom hostname for the PR review agent."
  value       = local.hostname
}

# Bound to the Worker as PUBLIC_BASE_URL (docs/07-PR-REVIEW-AGENT.md, "Report Assembly And
# Comment Posting" -- the posted comment's link back to "https://review-agent.cfapps.uk/reviews/
# {runId}"). A separate output from `hostname` above, rather than the Worker prefixing "https://"
# onto that output itself, so this stays a single self-contained, already-schemed value the
# Workflow never needs to reconstruct or guess a scheme for.
output "public_base_url" {
  description = "Full https:// base URL the Worker links back to from a posted review comment."
  value       = "https://${local.hostname}"
}

output "worker_name" {
  description = "Worker service name."
  value       = cloudflare_worker.demo.name
}
