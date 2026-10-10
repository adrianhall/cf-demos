{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "{{worker_name}}",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-07-27",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "vars": {
    "CLOUDFLARE_TEAM_DOMAIN": "{{cloudflare_team_domain}}",
    "ENVIRONMENT": "{{environment}}"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_id": "{{d1_database_id}}",
      "database_name": "{{d1_database_name}}",
      "migrations_dir": "./migrations"
    }
  ],
  "r2_buckets": [
    {
      "binding": "MEDIA",
      "bucket_name": "{{r2_bucket_name}}"
    }
  ],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "upload_source_maps": true
}
