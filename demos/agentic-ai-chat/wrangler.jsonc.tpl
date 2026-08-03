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
  // Workers AI has no local simulator: this binding always reaches the real account, in both
  // `vite dev` and a deployed Worker (docs/05-AI-CHAT.md, "Workers AI Has No Local Simulation").
  // Unused by any route until Phase 2 -- declared now so this phase's `compatibility_date`/flags
  // are exercised end to end and Phase 2 adds no new Wrangler config surface of its own.
  "ai": {
    "binding": "AI",
    "remote": true
  },
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "upload_source_maps": true
}
