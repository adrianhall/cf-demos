{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "{{worker_name}}",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-08-08",
  "workers_dev": false,
  "preview_urls": false,
  "vars": {
    "ADMIN_EMAIL": "{{admin_email}}",
    "CLOUDFLARE_TEAM_DOMAIN": "{{cloudflare_team_domain}}",
    "ENVIRONMENT": "{{environment}}"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "{{d1_database_name}}",
      "database_id": "{{d1_database_id}}",
      "migrations_dir": "./migrations"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "SHARES",
      "id": "{{shares_kv_namespace_id}}"
    }
  ],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "upload_source_maps": true,
  // Mirrors infra/architect.tf's cloudflare_worker.demo.observability literally, value for
  // value -- see that resource's comment for why this block must exist here at all (`wrangler
  // deploy` resets observability to disabled whenever its config carries no `observability`
  // block, even though Terraform already set one). Terraform still owns this Worker's
  // observability configuration -- these values are not read from a Terraform output because
  // they are static demo choices, not resource-generated data -- but this block must be changed
  // in lockstep with architect.tf's block any time either one changes.
  "observability": {
    "enabled": true,
    "logs": {
      "enabled": true,
      "head_sampling_rate": 1,
      "invocation_logs": true,
      "persist": true
    },
    "traces": {
      "enabled": true,
      "head_sampling_rate": 0.1,
      "persist": true
    }
  }
}
