{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "{{worker_name}}",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-08-04",
  // Required by the Agents SDK (ReviewRunAgent, ReviewPipelineWorkflow) -- see
  // docs/07-PR-REVIEW-AGENT.md, "Review Orchestration".
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "vars": {
    "CLOUDFLARE_TEAM_DOMAIN": "{{cloudflare_team_domain}}",
    "ENVIRONMENT": "{{environment}}",
    // Read at runtime via `env.AI.gateway(env.AI_GATEWAY_ID)` (docs/07-PR-REVIEW-AGENT.md,
    // "Cost Tracking") -- not a wrangler.jsonc binding, since the gateway id is a plain runtime
    // string argument, not a compiled binding reference.
    "AI_GATEWAY_ID": "{{ai_gateway_id}}",
    // The full https:// base URL `ReviewPipelineWorkflow`'s `merge-and-post-comment` step links
    // back to from a posted review comment (docs/07-PR-REVIEW-AGENT.md, "Report Assembly And
    // Comment Posting"). Passed in rather than hardcoded so `../review/report.ts`'s
    // `buildCommentBody()` stays testable with no environment dependency.
    "PUBLIC_BASE_URL": "{{public_base_url}}"
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
  // `vite dev` and a deployed Worker (docs/05-AI-CHAT.md, "Workers AI Has No Local Simulation";
  // docs/DECISIONS.md #9).
  "ai": {
    "binding": "AI",
    "remote": true
  },
  // `ReviewRunAgent` (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration") -- owns a review run's
  // live WebSocket connection and `state`/`broadcast()`, fed by `ReviewPipelineWorkflow`'s own
  // progress reports (src/worker/agents/ReviewRunAgent.ts).
  "durable_objects": {
    "bindings": [{ "name": "REVIEW_RUN", "class_name": "ReviewRunAgent" }]
  },
  // `ReviewPipelineWorkflow` (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration") -- the
  // deterministic fetch-diff -> review -> merge -> post-comment pipeline
  // (src/worker/workflows/ReviewPipelineWorkflow.ts). Note: `this.runWorkflow()` (called from
  // `ReviewRunAgent.start()`) takes this binding's own NAME ("REVIEW_PIPELINE"), not this
  // `class_name` -- confirmed by reading the installed `agents` package's own
  // `_findWorkflowBindingByName()` implementation, which resolves purely via `this.env[name]`.
  // Unlike `ai`, a Workflow binding has no `remote` option at all and is not supported under
  // `wrangler dev --remote`: Workflows' local-development story is a full local emulation of the
  // real engine, not a proxy to the deployed one.
  "workflows": [
    {
      "name": "review-pipeline-workflow",
      "binding": "REVIEW_PIPELINE",
      "class_name": "ReviewPipelineWorkflow"
    }
  ],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ReviewRunAgent"] }],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/agents/*"]
  },
  "upload_source_maps": true,
  // Mirrors infra/review-agent.tf's cloudflare_worker.demo.observability literally, value for
  // value -- see that resource's comment for why this block must exist here at all (`wrangler
  // deploy` resets observability to disabled whenever its config carries no `observability`
  // block, even though Terraform already set one; docs/DECISIONS.md #24/#25). Terraform still
  // owns this Worker's observability configuration -- these values are not read from a
  // Terraform output because they are static demo choices, not resource-generated data -- but
  // this block must be changed in lockstep with review-agent.tf's block any time either one
  // changes.
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
