{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "{{worker_name}}",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-07",
  "account_id": "{{account_id}}",
  "workers_dev": true,
  "preview_urls": false,
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "{{d1_database_name}}",
    "database_id": "{{d1_database_id}}",
    "migrations_dir": "migrations"
  }],
  "r2_buckets": [{
    "binding": "PROPOSALS",
    "bucket_name": "{{r2_bucket_name}}"
  }],
  "ai": { "binding": "AI" },
  "durable_objects": {
    "bindings": [{ "name": "JOB_NOTIFICATIONS", "class_name": "JobNotifications" }]
  },
  "exports": {
    "JobNotifications": { "type": "durable-object", "storage": "sqlite" }
  },
  "workflows": [{
    "name": "{{workflow_name}}",
    "binding": "ARCHITECTURE_WORKFLOW",
    "class_name": "ArchitectureWorkflow"
  }]
}
