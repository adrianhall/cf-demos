{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "{{worker_name}}",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-08-03",
  // Required by the Agents SDK's own configuration guidance ahead of Phase 2's ChatAgent, so
  // this flag does not need to land as a second, separate config change in that phase's diff.
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "vars": {
    "ADMIN_EMAIL": "{{admin_email}}",
    "AI_GATEWAY_ID": "{{ai_gateway_id}}",
    // The two dynamic routes' real Cloudflare-assigned names (docs/06-AGENTIC-CHAT.md Phase 4,
    // US-3) -- ChatAgent resolves a client-selected "basic"/"reasoning" literal to one of these
    // var values, then calls `dynamic/<value>`, never interpolating client input into a model
    // id (Section 6.3's "resolve by exact match" rule).
    "AI_GATEWAY_ROUTE_BASIC": "{{ai_gateway_route_basic}}",
    "AI_GATEWAY_ROUTE_REASONING": "{{ai_gateway_route_reasoning}}",
    // Needed to build the AI Gateway logs-list REST URL ChatAgent.reconcileUsage() calls
    // (docs/06-AGENTIC-CHAT.md Section 6.6 -- no binding lists logs). Not a secret on its own;
    // paired with the CLOUDFLARE_API_TOKEN Wrangler secret below, which is.
    "CLOUDFLARE_ACCOUNT_ID": "{{cloudflare_account_id}}",
    "CLOUDFLARE_TEAM_DOMAIN": "{{cloudflare_team_domain}}",
    "ENVIRONMENT": "{{environment}}"
  },
  // CLOUDFLARE_API_TOKEN itself is a Wrangler secret, not a var -- pushed by
  // `npm run deploy:worker:secrets` from this repo's own .env, never committed here (see
  // AGENTS.md's "Observability And Security" section and package.json's deploy:worker chain).
  // Declaring it as `required` here (rather than leaving Wrangler to infer it from `.dev.vars`)
  // is what makes `generate-wrangler-types` emit it on the generated `Env` type at all.
  "secrets": {
    "required": ["CLOUDFLARE_API_TOKEN"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "{{d1_database_name}}",
      "database_id": "{{d1_database_id}}",
      "migrations_dir": "./migrations"
    }
  ],
  // Workers AI has no local simulator: this binding always reaches the real account, in both
  // `vite dev` and a deployed Worker (docs/05-AI-CHAT.md, "Workers AI Has No Local Simulation").
  "ai": {
    "binding": "AI",
    "remote": true
  },
  // Agent-generated files (docs/06-AGENTIC-CHAT.md Phase 9, US-8) -- `ChatAgent`'s
  // `writeMarkdown` tool is the only writer.
  "r2_buckets": [
    {
      "binding": "FILES",
      "bucket_name": "{{r2_bucket_name}}"
    }
  ],
  // One Durable Object per chat (docs/06-AGENTIC-CHAT.md Section 6.2), addressed by
  // `getAgentByName()` rather than `routeAgentRequest()`'s default routing (Spike A).
  "durable_objects": {
    "bindings": [{ "name": "CHAT_AGENT", "class_name": "ChatAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatAgent"] }],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "upload_source_maps": true
}
