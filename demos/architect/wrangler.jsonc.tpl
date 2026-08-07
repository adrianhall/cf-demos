{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "{{worker_name}}",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-07-29",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "vars": {
    "CLOUDFLARE_TEAM_DOMAIN": "{{cloudflare_team_domain}}",
    "ENVIRONMENT": "{{environment}}"
  },
  "d1_databases": [{ "binding": "DB", "database_name": "{{d1_database_name}}", "database_id": "{{d1_database_id}}", "migrations_dir": "./migrations" }],
  "r2_buckets": [{ "binding": "SNAPSHOTS", "bucket_name": "{{r2_bucket_name}}" }],
  "kv_namespaces": [{ "binding": "SHARES", "id": "{{shares_kv_namespace_id}}" }],
  "durable_objects": { "bindings": [{ "name": "DIAGRAM_ROOM", "class_name": "DiagramRoom" }] },
  "exports": { "DiagramRoom": { "type": "durable-object", "storage": "sqlite" } },
  "workflows": [{ "binding": "ARCHITECTURE_WORKFLOW", "name": "{{workflow_name}}", "class_name": "ArchitectureWorkflow" }],
  "ai": { "binding": "AI" },
  "assets": { "directory": "./dist", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*", "/shared/*"] },
  "upload_source_maps": true
}
