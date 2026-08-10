{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "{{worker_name}}",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-08-08",
  // Required by `agents/mcp/server`'s `createMcpHandler` (docs/09B-ARCHITECT-MCP.md's remote MCP
  // server), which imports `node:async_hooks`'s `AsyncLocalStorage` at module scope to track its
  // per-request auth context.
  "compatibility_flags": ["nodejs_compat"],
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
  // `DiagramSession` (docs/09B-ARCHITECT-MCP.md's Live Sync Architecture) is a Wrangler-owned
  // Durable Object namespace, not a Terraform resource -- mirroring `demos/chat`'s `ChatRoom` and
  // this repository's standing precedent (docs/10-OPENCODE-BROWSER.md) for why Durable Object
  // namespaces are declared here, not in `infra/architect.tf`. Both fields below are static demo
  // choices, not Terraform-sourced values, so neither is substituted from a template marker.
  "durable_objects": {
    "bindings": [
      {
        "name": "DIAGRAM_SESSIONS",
        "class_name": "DiagramSession"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["DiagramSession"]
    }
  ],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    // `/mcp*` added alongside `/api/*` for docs/09B-ARCHITECT-MCP.md's remote MCP server --
    // without its own entry, `/mcp` falls through to the `ASSETS` binding's SPA fallback and
    // 404s before this Worker ever sees the request.
    "run_worker_first": ["/api/*", "/mcp*"]
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
