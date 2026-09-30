# 11 — Operations and lifecycle

## 1. Required scripts

`codeflare/package.json` must define the five root-mandated scripts and use `npm-run-all2` `run-s` plus
colon-namespaced sub-scripts.

```json
{
  "scripts": {
    "start": "run-s start:prepare start:dev",
    "start:prepare": "run-s check:types migrate:local",
    "start:dev": "cf dev --persist-to .cloudflare/state",

    "check": "run-s check:types check:format check:lint check:config check:infra",
    "check:types": "run-s check:generate-types check:tsc",
    "check:generate-types": "cf workers types --mode development",
    "check:tsc": "tsc --noEmit",
    "check:format": "oxfmt --check .",
    "check:lint": "oxlint",
    "check:config": "cf check",
    "check:infra": "run-s check:d1 check:terraform",
    "check:d1": "node ../scripts/verify-d1-migrations.mjs",
    "check:terraform": "node ../scripts/no-terraform-required.mjs",

    "fix": "run-s fix:format fix:lint fix:config",
    "fix:format": "oxfmt --write .",
    "fix:lint": "oxlint --fix",
    "fix:config": "cf workers types --mode development",

    "test": "run-s test:unit test:ui test:integration",
    "test:unit": "vitest run test/unit",
    "test:ui": "vitest run test/ui",
    "test:integration": "vitest run test/integration",

    "deploy": "run-s deploy:preflight deploy:resources deploy:access deploy:build deploy:worker",
    "teardown": "run-s teardown:worker teardown:access teardown:resources",

    "migrate:local": "node ../scripts/d1-migrate.ts --cwd . --outputs infra/local-outputs.json --local",
    "migrate:remote": "node ../scripts/d1-migrate.ts --cwd . --outputs infra/outputs.json"
  }
}
```

The exact helper paths are illustrative: the implementation must conform to root D1 rules. If Codeflare
uses D1, it needs the scalar `d1_database_id` output and committed `infra/local-outputs.json`, and
uses `scripts/d1-migrate.ts`, never direct `cf d1 migrations apply` in a demo script.

`pnpm check` must not write files. Generation that writes belongs in `fix` or an explicit
preparation step, except where repository policy requires type freshness within `check:types`; make
that behaviour CI-safe and document it. Resolve this apparent root-rule tension before coding
rather than silently violating either side.

## 2. Deploy lifecycle

### Preflight

- Verify required root `.env` keys exist without printing their values.
- Verify `cf` is available at the pinned version.
- Generate/check types.
- Run format, lint, TypeScript, unit/UI/integration tests.
- Verify no Wrangler dependency/configuration/command exists.

### Resources

`cf` owns resources because Codeflare is deliberately non-Terraform unless a documented gap forces it:

- D1 database.
- R2 buckets for logs/artifacts.
- KV namespace for preview index/cache.
- Secrets Store references/bindings.
- Preview-zone wildcard DNS record.
- Any event subscription/queue needed for Artifacts CI.

Every create is idempotent: look up by deterministic name/tag before create. Save scalar IDs to the
ignored remote outputs file and documented local placeholder output file.

### Access

Use `@adrianhall/cloudflare-toolkit`’s `cf-access-controls` command to install/reconcile:

- App hostname application.
- Preview wildcard hostname application.
- Public bypass paths.
- Team-member allow policy.

Do not leave Access controls unmanaged merely because the Worker deploys successfully.

### Worker

Build with `cf build`; deploy prebuilt output with `cf deploy --prebuilt` where the family
convention requires. `cloudflare.config.ts` is the only Worker configuration source of truth.

### Teardown

Order matters:

1. Disable/delete the deployed Worker application first, so its bindings do not block deletion.
2. Delete Access controls.
3. Stop/reap active session containers and delete dynamic Artifacts project repos created by the
   demo, with confirmation disabled/non-interactive because the script is a controlled lifecycle.
4. Delete R2 objects before bucket deletion.
5. Delete queues/KV/D1/DNS/Secrets Store bindings/resources in reverse dependency order.

A second `pnpm teardown` is successful and reports that absent resources were already absent.

## 3. Container lifecycle operations

| Operation                  | Action                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| First session message      | Start `standard-2` from named image, clone/restore, set timeout, arm alarm.                 |
| Agent work active          | Alarm every 60 s; ensure timeout is present; monitor tool process state.                    |
| Terminal attached          | Terminal WebSocket keeps DO active; tmux persists across reconnect.                         |
| Dev server live            | Alarm retains container through configured preview idle period.                              |
| No activity                | Snapshot filesystem, persist ID, stop/destroy container, set `sleeping`.                    |
| Wake                       | Start from snapshot; if absent/expired, recover from Artifacts branch and mark cold restore. |
| Worker deploy              | Constructor re-establishes timeout if container is still running.                            |
| Archive/delete             | Stop process groups, snapshot if archive, destroy container, unregister preview.            |

### Snapshot strategy

Snapshots include `node_modules`, so they optimise warm continuation but may be large. Measure
snapshot/restore times and sizes. If a project regularly exceeds snapshot limits:

1. Preserve source truth in Artifacts (always).
2. Store package-manager cache/build cache in R2 if feasible.
3. Restore by clone + install, with an explicit “rebuilding environment” state.
4. Do **not** silently omit files from a snapshot.

## 4. Budgets and cost controls

### Limits

| Scope       | Controls                                                            |
| ----------- | ------------------------------------------------------------------- |
| Session     | Max model USD, container minutes, turns, active sub-agents.         |
| Project     | Aggregate model USD, aggregate container minutes, concurrent sessions. |
| Team        | Maximum active containers, maximum instance tier, monthly warning thresholds. |

### Enforcement points

- **Before a turn:** project/session spend and turn budget.
- **Before container start:** concurrent container count and allowed instance size.
- **During a tool:** command timeout and output cap.
- **On agent model response:** actual token/spend ledger update.
- **On alarm:** accumulated runtime and stuck-process detection.
- **Before background sub-agent:** remaining parent budget.

Budget events are audit events. An automatic stop is never silent.

### Cost display

The UI reports measured elapsed runtime and actual model cost; it may show an estimate for a running
container but labels it as an estimate. Do not pretend exact cloud billing data is synchronous.

## 5. Observability

### Logs

Use toolkit structured logging. Required fields:

```ts
interface LogContext {
  requestId: string;
  correlationId: string;
  projectId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  userEmailHash?: string; // never raw email in broad logs
  operation?: string;
}
```

Never log source contents, Access JWTs, Authorization headers, secrets, raw model prompts, or raw
terminal input by default. Debug source capture, if ever added, is an opt-in, short-retained,
admin-only diagnostic feature.

### Traces

Enable Workers observability and create spans:

- `codeflare.session.turn`
- `codeflare.agent.tool`
- `codeflare.container.start`
- `codeflare.container.snapshot`
- `codeflare.git.clone`
- `codeflare.git.commit`
- `codeflare.git.merge`
- `codeflare.git.publish`
- `codeflare.preview.start`

Attributes must use IDs/hashes, not source content or credentials. Record exceptions with the
Workers tracing API after redacting provider error bodies.

### Metrics and alerts

| Metric                                 | Alert / dashboard use                                      |
| -------------------------------------- | ---------------------------------------------------------- |
| Active containers by instance type     | Capacity and runaway detection.                            |
| Container start/restore latency        | NFR-PERF-020.                                              |
| Snapshot size/time/failures            | Snapshot-limit risk.                                       |
| Active/failed agent turns              | Recovery health.                                           |
| Model spend by project/session/model   | Budget and anomaly detection.                              |
| Tool-call error rate                   | Agent/regression quality.                                  |
| Preview start/crash rate               | Toolchain detection quality.                               |
| Merge queue duration/conflict rate     | Parallel-work effectiveness.                               |
| Publish success/failure by provider    | External-remote health.                                    |

## 6. Scheduled maintenance

A scheduled handler/Workflow runs at least daily:

1. Find sessions whose snapshots are close to expiry; notify owners or archive according to policy.
2. Reap archived sessions and Artifacts branches/repos beyond retention.
3. Reconcile D1 sessions marked running with actual container state; mark abandoned work as failed
   with a remediation action.
4. Delete orphaned preview KV entries and per-session Access sharing policies.
5. Reconcile Artifacts repos against project rows; flag (do not immediately delete) unknown repos.
6. Reconcile budgets and emit team-level threshold alerts.
7. Prune R2 log/diff objects with lifecycle rules.

The job must be idempotent and chunk/paginate work. Do not scan unbounded accounts in one Worker
invocation.

## 7. Incident playbooks

### Runaway cost

1. Admin disables new session creation via a team-level feature flag.
2. Stop active sessions over budget; snapshot if possible.
3. Query logs/traces by project/session to identify the source.
4. Revoke the affected model policy or provider route in AI Gateway.
5. Re-enable after remediation; document incident in audit log.

### Suspected credential leak

1. Revoke/rotate the affected secret in Secrets Store/provider.
2. Stop affected session and publish containers; preserve artifacts/forensics without running them.
3. Inspect outbound logs for destination/path, not request bodies.
4. Verify no token reached `.git/config` or process environment using the security test harness.
5. Patch egress handler/policy and redeploy.

### Broken preview WebSockets

1. Verify hostname-based (not Worker-level) Access application.
2. Check Access application permits the preview hostname.
3. Inspect proxy preservation of Upgrade headers.
4. Confirm dev server binds `0.0.0.0` and port matches toolchain.
5. Check SessionDO/Container logs and container readiness poll.

### Snapshot restore failure

1. Mark session failed; do not start a blank container.
2. Preserve transcript and Artifacts branch.
3. Offer “recover from branch” that creates a new environment clone.
4. Record snapshot ID, image reference, and error in trace/audit.

## 8. Configuration

`cloudflare.config.ts` binds all runtime resources and is typed. It includes:

- Compatibility date pinned deliberately.
- `nodejs_compat` and any required experimental flags.
- `exports` declarations for Durable Objects with SQLite storage.
- Container named images and `durable_object` scheduling policy.
- D1/KV/R2/Artifacts/Secrets Store bindings.
- Worker route for app plus wildcard preview route.
- Observability enabled.
- Preview/Workers Dev settings.

Secrets are declared as required but values are never in configuration. Generated binding types are
included in `tsconfig.json` and are never handwritten.
