# Spike 10 Report: Deployed Architecture Workflow

Run on 2026-08-07. This disposable spike used only `POST /jobs` and `GET /jobs/:id` from its external Node runner. It did not use `wrangler dev`, `--remote`, a remote binding, a browser, or a direct Cloudflare API call from that runner. All deployments used the unique Worker name `spike-10-architect-workflow-20260807-a1f4c9` and were torn down.

## Resolved versions

| Component | Resolved version |
| --- | --- |
| Node | 24.x runtime requirement |
| TypeScript | 6.0.3 |
| Wrangler | 4.115.0 |
| workerd | 1.20260722.1 |
| `@adrianhall/cloudflare-toolkit` | 2.3.0 |
| Cloudflare Terraform provider | 5.22.0 |
| dotenv Terraform provider | 1.0.1 |
| Terraform CLI requirement | >= 1.10.0 |

## Source-verified

- `wrangler.jsonc.tpl` declares `JOB_NOTIFICATIONS` (`JobNotifications`), `ARCHITECTURE_WORKFLOW` (`ArchitectureWorkflow`), `AI`, `DB`, and `PROPOSALS` in one Worker.
- Durable Object lifecycle uses the current declarative `exports` form: `JobNotifications` is declared as `{ "type": "durable-object", "storage": "sqlite" }`; no legacy `migrations` array is present.
- The Workflow uses durable `summarize`, `generate`, and `store` steps. The generation step is configured with two retries and exponential backoff.
- D1 is updated before the Workflow records each per-job Durable Object notification. `GET /jobs/:id` selects the D1 row and calls the same job's Durable Object `last()` method.
- The only probe inputs are `{"fixture":"successful"}` and `{"fixture":"invalid"}`. The invalid fixture produces an unknown product locally, so validation must follow `summarizing -> generating -> validating -> failed` without a model-dependent result.
- The final selected binding model is `@cf/meta/llama-3.1-8b-instruct-fast`. The unqualified `@cf/meta/llama-3.1-8b-instruct` is deprecated as of 2026-05-30.

## Locally verified

- `generate-wrangler -c -l infra/local-outputs.json` produced a local canonical `wrangler.jsonc`; this is configuration/type validation only, not a local Worker run.
- `generate-wrangler-types`, `tsc --noEmit`, `terraform fmt -check`, and `terraform validate` passed.
- No local Workflow execution was attempted. This preserves the spike restriction against `wrangler dev`; it leaves local Workflow runtime parity unproven in this spike.

## Deployed findings

- Terraform successfully created the exactly scoped bypass Access policy/application for the unique workers.dev hostname, one D1 database, one R2 bucket, and the Worker registration in each attempt.
- Wrangler deployed the Worker and reported all five requested bindings plus declarative Durable Object export reconciliation and the Workflow declaration.
- Remote D1 migration `0001_jobs.sql` applied successfully before every HTTP probe.
- A successful fixture reached `failed` in one deployed run because the initially selected unqualified model returned `5028` (deprecated). D1 and the Durable Object both reported `failed`, proving the D1-plus-DO read path and terminal finalization when the Workflow executes.
- After switching to the documented surviving `-fast` variant, the final deployed attempt stayed `queued` for the runner's 120 polls (three minutes) and emitted no Durable Object notification. It therefore did not prove a successful AI/R2 job, nor the deliberate invalid fixture on that final run.
- An earlier direct Durable Object RPC status read intermittently returned `500` immediately after deployment. The runner now retries transient status-read 500s for its first 15 polls. The final queued run did not recover into a Workflow execution.

## HTTP polling contract

- `POST /jobs` requires exact `application/json` and one fixed fixture. It returns `202` with `{ id, status: "queued" }`.
- `GET /jobs/:id` returns `{ job, notification }`, where `job` is D1 state and `notification` is the durable last notification. It returns `404` for an absent job.
- The runner polls every 1.5 seconds up to 120 times. It succeeds only when both D1 `job.status` and Durable Object `notification.status` match the expected terminal status.

## Status transitions and parity

| Fixture | Required transition | Deployed result |
| --- | --- | --- |
| successful | queued, summarizing, generating, validating, storing, ready | Blocked: first model deprecated; replacement remained queued. |
| invalid | queued, summarizing, generating, validating, failed | Source-validated deterministic path; not reached in final deployed run because the prior successful fixture never completed. |

The locally represented transition model is sound at source/type level, but deployed Workflow scheduling/start latency is not at parity with this spike's expected immediate polling behavior. Treat it as a deployment blocker, not a successful parity result.

## Teardown evidence

Every attempted lifecycle ran cleanup in `finally`, including failed assertions. The final `teardown-results.json` records exit code 0 for each command, in this exact order:

1. `wrangler delete --force --config wrangler.jsonc` deleted the Worker and Wrangler-managed bindings.
2. `empty-r2-bucket -t infra --env-file ../../.env --yes` found the R2 bucket empty.
3. `terraform -chdir=infra destroy -auto-approve` destroyed the D1 database, R2 bucket, Access application, and Access policy. The Worker had already been deleted by Wrangler, so Terraform destroyed four remaining resources.

`terraform -chdir=infra state list` is empty after the final cleanup.

## Phase 5 corrections

- Do not use `@cf/meta/llama-3.1-8b-instruct`; use a currently cataloged model and retain a deployed smoke check because model availability changed during this spike.
- Keep the top-level D1-plus-Durable-Object terminal-finalization pattern, which was observed for the model-deprecation failure.
- Phase 5 must add a controlled deployed Workflow-start/readiness investigation before relying on a short HTTP polling window. This spike observed a persistent `queued` instance after the replacement-model deployment, so production orchestration should expose queue/start delay separately from model execution delay.
- Do not claim AI/R2 success or local/deployed parity until a fresh deployed run reaches `ready` and the invalid fixture reaches durable `failed` after the Workflow starts.
