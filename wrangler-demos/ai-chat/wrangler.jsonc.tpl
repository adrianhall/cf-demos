{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "{{worker_name}}",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-07-31",
  "workers_dev": false,
  "preview_urls": false,
  "vars": {
    "CLOUDFLARE_TEAM_DOMAIN": "{{cloudflare_team_domain}}",
    "ENVIRONMENT": "{{environment}}"
  },
  // Workers AI has no local simulator: this binding always reaches the real account, in both
  // `vite dev` and a deployed Worker. Cloudflare errors if `remote` is `false` here and warns
  // (while still connecting remotely) if it is omitted, so it is set explicitly. See
  // docs/05-AI-CHAT.md ("Workers AI Has No Local Simulation").
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
