{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "{{worker_name}}",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-07-24",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "vars": {
    "ADMIN_EMAIL": "{{admin_email}}",
    "CLOUDFLARE_TEAM_DOMAIN": "{{cloudflare_team_domain}}",
    "ENVIRONMENT": "{{environment}}"
  },
  "kv_namespaces": [
    {
      "binding": "LINKS",
      "id": "{{links_kv_namespace_id}}"
    }
  ],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/l/*"]
  },
  "upload_source_maps": true
}
