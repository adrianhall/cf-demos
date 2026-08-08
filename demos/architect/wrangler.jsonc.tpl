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
  "upload_source_maps": true
}
