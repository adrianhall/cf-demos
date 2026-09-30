# 16 — Enterprise concurrency, capacity, and telemetry focus

This document records the concerns raised when considering Codeflare for an enterprise deployment of
approximately 2,000 users.

It is **not an implementation plan or immediate scale-out requirement**. The initial goal is to make
capacity, concurrency, resource usage, and failure modes observable enough to learn from a pilot.
Codeflare should first measure real usage patterns before introducing complex admission control,
resource pooling, repository topology changes, or multi-account deployment.

## 1. Scope and intent

The existing specification is primarily designed around a single team and a small number of active
sessions. Enterprise usage changes the questions that must be answered:

- How many users are active concurrently?
- How many agent sessions are active at once?
- How many sessions have running Containers, previews, terminals, or background agents?
- Which projects create coordination hotspots?
- How much model, Container, storage, egress, and Git activity does each unit of work generate?
- What happens when Cloudflare or Artifacts limits are approached?

The first phase should answer those questions with telemetry and dashboards. It should not prematurely
introduce a complicated scheduler or resource broker based on assumptions.

## 2. Enterprise scale concerns

### 2.1 Registered users are not concurrent users

“2,000 users” is not a capacity number by itself. Capacity planning must distinguish:

```text
Registered users:
Daily active users:
Weekly active users:
Peak concurrent browser users:
Peak concurrent connected sessions:
Peak concurrent agent turns:
Peak concurrent Containers:
Peak concurrent previews:
Peak concurrent background processes:
Peak model requests per minute:
```

The pilot must collect these values. A deployment with 2,000 registered users and 50 active sessions
has a very different shape from one with 2,000 users and 2,000 simultaneously running Containers.

### 2.2 Container capacity

The current design gives each agent session a dedicated Container. This is a strong isolation boundary,
but it is also the dominant capacity and cost concern.

A `standard-2` Container provisions approximately:

- 1 vCPU
- 6 GiB memory
- 12 GB disk

The documented account-level Container limits include approximately:

- 1,500 concurrent vCPU
- 6 TiB concurrent memory
- 30 TB concurrent disk

Therefore, 2,000 simultaneous `standard-2` sessions would exceed the documented vCPU limit and
would place considerable pressure on memory and disk limits. Even substantially fewer active sessions
may be expensive if they remain running unnecessarily.

The initial response should be measurement, not automatic redesign:

- Record instance type and actual running duration.
- Record cold starts, warm starts, restores, and stop reasons.
- Record provisioned memory/disk and active CPU duration where available.
- Record the number of sessions that actually need a full Container.
- Compare active work against idle sessions and preview-only sessions.

### 2.3 Project coordination hotspots

`ProjectDO` currently coordinates the merge queue and project-level live-session state. This is simple
and strongly consistent, but a popular monorepo could make one object a hotspot.

Monitor:

- Requests per `ProjectDO`.
- Queue depth and queue wait time.
- Merge duration and conflict rate.
- Number of sessions per project.
- Event fan-out count per project.
- DO invocation duration and storage latency.
- The proportion of project requests that are merge-related versus listing/notification-related.

Do not split the object until telemetry shows a problem. If a hotspot appears, likely future changes
include:

- Separate merge coordination from session listing.
- Serialise per target branch rather than per entire project.
- Move read-heavy listings to D1 projections.
- Coalesce or decouple high-volume event fan-out.

### 2.4 Artifacts repository scale

Artifacts is the working Git store in the current design. This is operationally attractive, but
enterprise usage raises questions about repository size, commit rate, branch retention, and namespace
traffic.

Monitor:

- Repository size and growth rate.
- Number of active and stale session branches.
- Commits and pushes per session/project/time period.
- Clone, fetch, and push latency.
- Artifacts request rates and 429/throttling responses.
- Git failures by operation and repository.
- Time spent in branch creation, clone, push, diff, and merge operations.
- Namespace and account storage consumption.

The current branch-per-session model should remain the default during the pilot unless measurements
show that repository contention or size is a problem. Possible future alternatives include session
fork repositories or external-source mode, but neither should be introduced speculatively.

### 2.5 Persistent connections

A large user population may produce more connections than active agent turns. A user can have:

- A session event WebSocket.
- One or more terminal WebSockets.
- Preview/HMR WebSockets.
- Multiple browser tabs.
- Reconnecting clients after deployment or network loss.

Monitor:

- Connected WebSockets by type.
- Connections per user, session, and project.
- Connection duration.
- Reconnect rate and reconnect reason.
- Event backlog per client.
- Slow-consumer disconnects.
- Terminal output bytes per connection.
- HMR connection failures.
- WebSocket close codes during Worker deployments.

The system should initially impose conservative documented limits and expose when they are reached,
rather than silently degrading.

### 2.6 Cost concentration

A small number of users or projects may consume a disproportionate share of resources. Enterprise
telemetry must identify concentration without exposing source code or secrets.

Useful dimensions include:

- Team.
- Department or cost center, if configured.
- User subject hash.
- Project.
- Session.
- Model/provider.
- Container instance type.
- Preview.
- Git provider.
- Operation type.

The product should distinguish measured usage from final provider billing. Runtime telemetry can
provide estimates and attribution, but it should not claim to be an invoice.

## 3. Initial telemetry objectives

The first enterprise-focused milestone is an observability baseline with no major concurrency-model
change.

### Objective A — Establish a concurrency profile

Answer:

- What is the p50, p95, and peak number of active users?
- What is the p50, p95, and peak number of active sessions?
- How many active sessions have running Containers?
- How many sessions are working, awaiting input, ready, sleeping, failed, or archived?
- How often do users reconnect after disconnecting?

### Objective B — Establish a resource profile

Answer:

- Which Container sizes are actually used?
- How long do Containers run per session?
- How frequently are Containers restored from snapshots?
- How large are snapshots?
- How often do sessions exceed configured budgets?
- How often do cold starts or restores fail?

### Objective C — Find coordination hotspots

Answer:

- Which projects have the most active sessions?
- Which projects have the longest merge queues?
- Which projects have the highest merge conflict rate?
- Which Durable Objects have unusual request volume or latency?
- Are project-level events or merge operations responsible for most load?

### Objective D — Establish external-service pressure

Answer:

- Are Artifacts operations approaching documented request rates?
- How much Git traffic is generated by agent commits and pushes?
- Which GitHub/GitLab publish operations fail or time out?
- Which model providers or AI Gateway routes dominate spend and latency?
- How much package-registry and egress traffic do sessions generate?

## 4. Required telemetry fields

Every request, event, operation, and resource measurement should carry a correlation context where
possible.

```ts
interface EnterpriseTelemetryContext {
  requestId: string;
  correlationId: string;
  projectId?: string;
  sessionId?: string;
  userSubjectHash?: string;
  departmentId?: string;
  costCenter?: string;
  operation?: string;
  targetBranch?: string;
  containerInstance?: string;
  model?: string;
  provider?: string;
}
```

Do not place raw email addresses, Access JWTs, source contents, prompts, model responses, tokens,
SSH keys, or Authorization headers in broad telemetry.

`departmentId`, `costCenter`, and similar fields are optional enterprise metadata. They must be
configured explicitly and must not be inferred from arbitrary user input.

## 5. Metrics catalogue

### 5.1 User and session activity

| Metric | Type | Dimensions | Purpose |
| ------ | ---- | ---------- | ------- |
| `codeflare.users.active` | Gauge | team, department | Concurrent authenticated users with activity in the observation window. |
| `codeflare.sessions.active` | Gauge | project, status, instance | Sessions with active UI or work. |
| `codeflare.sessions.running_containers` | Gauge | instance, project | Active Container count. |
| `codeflare.sessions.created` | Counter | project, creator role | Demand rate. |
| `codeflare.sessions.sleeping` | Gauge | project | Hibernated workload. |
| `codeflare.sessions.failed` | Counter | failure reason | Reliability and recovery. |
| `codeflare.session.connection_count` | Gauge | connection type | WebSocket pressure. |
| `codeflare.session.reconnects` | Counter | connection type, reason | Network/deploy reliability. |

Define “active user” and observation windows explicitly. The dashboard must not mix a five-minute
active-user count with a one-hour session count without clear labels.

### 5.2 Container and snapshot metrics

| Metric | Type | Dimensions | Purpose |
| ------ | ---- | ---------- | ------- |
| `codeflare.container.starts` | Counter | cold, restore, image, instance | Demand and startup behaviour. |
| `codeflare.container.start_latency_ms` | Histogram | cold/restore, instance | NFR-PERF-020 and capacity planning. |
| `codeflare.container.running_seconds` | Counter/histogram | instance, project | Runtime attribution. |
| `codeflare.container.stop_reason` | Counter | idle, user, error, budget, deploy | Lifecycle quality. |
| `codeflare.container.snapshot_size_bytes` | Histogram | project, image | Snapshot pressure. |
| `codeflare.container.snapshot_latency_ms` | Histogram | size bucket | Save/restore performance. |
| `codeflare.container.restore_failures` | Counter | reason, image | Recovery risk. |
| `codeflare.container.concurrent` | Gauge | instance | Account capacity. |
| `codeflare.container.command_duration_ms` | Histogram | tool, exit status | Workload profile. |

Where platform metrics are not available directly, label values as estimates. Do not create false
precision from local timers.

### 5.3 Agent and model metrics

| Metric | Type | Dimensions | Purpose |
| ------ | ---- | ---------- | ------- |
| `codeflare.agent.turns.started` | Counter | model, project | Agent demand. |
| `codeflare.agent.turns.completed` | Counter | outcome | Reliability. |
| `codeflare.agent.turn_duration_ms` | Histogram | model, outcome | User experience. |
| `codeflare.agent.first_token_ms` | Histogram | model/provider | Responsiveness. |
| `codeflare.agent.tool_calls` | Counter | tool, outcome | Tool usage and failures. |
| `codeflare.agent.background_runs` | Gauge | status | Detached sub-agent pressure. |
| `codeflare.ai.input_tokens` | Counter | model, project | Usage attribution. |
| `codeflare.ai.output_tokens` | Counter | model, project | Usage attribution. |
| `codeflare.ai.estimated_spend_usd` | Counter | provider, model, project | Budget monitoring. |
| `codeflare.ai.budget_blocks` | Counter | dimension | Policy effectiveness. |

### 5.4 Git and Artifacts metrics

| Metric | Type | Dimensions | Purpose |
| ------ | ---- | ---------- | ------- |
| `codeflare.artifacts.operation_count` | Counter | operation, project | Artifacts demand. |
| `codeflare.artifacts.operation_latency_ms` | Histogram | operation, status | Git/control-plane performance. |
| `codeflare.artifacts.rate_limited` | Counter | operation, namespace | Early warning for limits. |
| `codeflare.git.clone_bytes` | Counter | project | Repository traffic. |
| `codeflare.git.push_bytes` | Counter | project, session | Commit/push pressure. |
| `codeflare.git.branch_count` | Gauge | project | Branch retention. |
| `codeflare.git.repository_size_bytes` | Gauge | project | Storage growth. |
| `codeflare.git.merge_queue_depth` | Gauge | project, target branch | Coordination pressure. |
| `codeflare.git.merge_wait_ms` | Histogram | project, target branch | User-visible queue delay. |
| `codeflare.git.conflicts` | Counter | project | Parallel-work friction. |
| `codeflare.publish.operations` | Counter | provider, protocol, outcome | External publishing health. |

### 5.5 Preview and terminal metrics

| Metric | Type | Dimensions | Purpose |
| ------ | ---- | ---------- | ------- |
| `codeflare.preview.starts` | Counter | project, outcome | Preview demand. |
| `codeflare.preview.ready_latency_ms` | Histogram | instance, project | Preview experience. |
| `codeflare.preview.crashes` | Counter | framework, reason | Toolchain quality. |
| `codeflare.preview.websocket_connections` | Gauge | project | Persistent connection pressure. |
| `codeflare.preview.requests` | Counter | status class | Traffic volume. |
| `codeflare.preview.bytes_out` | Counter | project | Egress/cost profile. |
| `codeflare.terminal.connections` | Gauge | project, session | Terminal pressure. |
| `codeflare.terminal.reconnects` | Counter | reason | Reliability. |
| `codeflare.terminal.output_bytes` | Counter | session | Slow-consumer and cost analysis. |

## 6. Dashboards

### Executive/platform capacity dashboard

Shows:

- Active users versus configured enterprise population.
- Active sessions and running Containers.
- Container capacity by instance type.
- Current and peak memory/vCPU/disk allocation.
- Cold-start and restore latency.
- AI and Container usage estimates.
- Error and rate-limit trends.

### Operations dashboard

Shows:

- Failed sessions.
- Stuck or long-running turns.
- Snapshot restore failures.
- ProjectDO request latency and invocation volume.
- Merge queues and conflicts.
- WebSocket disconnect/reconnect rates.
- Preview crashes and readiness failures.
- External publish failures.

### Project-owner dashboard

Shows only projects the viewer is authorised to see:

- Active sessions.
- Session states.
- Agent runtime and estimated spend.
- Branch count and repository size.
- Merge queue time.
- Preview health.

### Security dashboard

Shows:

- Failed Access authorization attempts.
- Cross-project/session authorization denials.
- Blocked egress attempts by hostname/category.
- Credential-injection failures.
- Approval requests and rejected dangerous operations.
- Publishing operations and remote/provider.
- Secret rotation and remote configuration changes.

Do not make source code, prompts, terminal input, or model output searchable in general operational
telemetry. Those belong to separately controlled transcript/audit surfaces.

## 7. Alerts for the pilot

These are initial alerting signals, not permanent thresholds. Establish baselines first and tune
thresholds using p95/p99 and sustained windows.

### Capacity alerts

- Running Containers exceed 70% of the configured team/account budget for 10 minutes.
- Provisioned memory, vCPU, or disk exceeds 80% of the approved capacity envelope.
- Container start failures increase above baseline.
- Cold-start p95 exceeds the user experience target.
- Snapshot restore failures occur for the same image/project repeatedly.

### Coordination alerts

- A project merge queue exceeds a configured wait time.
- A `ProjectDO` has sustained high request latency or invocation volume.
- A project has abnormal event fan-out or observer count.
- Artifacts operation rate approaches a documented limit.
- Artifacts rate limiting occurs.

### Cost alerts

- Team/project/session estimated spend exceeds warning threshold.
- A session runs beyond expected container duration.
- A user or project accounts for an unusual fraction of total usage.
- Model spend or Container runtime changes materially from baseline.
- Egress grows unexpectedly.

### Reliability alerts

- Agent turn recovery/failure rate increases.
- WebSocket reconnect rate increases after a deployment.
- Preview startup/crash rate exceeds baseline.
- External publish failures cluster by provider/protocol.

## 8. Privacy, retention, and cardinality

Telemetry must be useful without becoming a shadow source-code archive.

- Hash or pseudonymise user subjects in broad metrics.
- Keep raw user identity in access-controlled audit records only when required.
- Never use file paths, branch names, prompts, source snippets, or command contents as unbounded
  metric labels.
- Cap label cardinality for project/session dashboards; provide drill-down links to authorised
  records instead.
- Define separate retention for metrics, operational logs, audit events, and transcripts.
- Redact Authorization headers, token-like strings, private keys, and provider credentials at the
  logging boundary.
- Record estimated model cost with the pricing/model-policy version used to calculate it.
- Mark values as estimated when Cloudflare/provider billing data is not final.

## 9. What telemetry may lead to later

The initial telemetry phase should inform, rather than commit to, later architecture changes.

### Admission control

If demand exceeds safe capacity, introduce:

- Team/project/user active-session quotas.
- A cold-start queue.
- Per-instance-type quotas.
- Priority classes for interactive work versus CI/background work.
- A clear user-facing “capacity unavailable” state.

### Resource class selection

If many sessions do not need a full Container:

- Use `lite` or `basic` for planning/review.
- Use full instances only for installs, builds, tests, or dev servers.
- Consider Dynamic Workers/Code Mode for lightweight file analysis.
- Preserve isolation; do not pool sessions unless the security model remains equivalent.

### Project coordination sharding

If telemetry shows ProjectDO hotspots:

- Separate merge queue coordination from read-heavy project/session listing.
- Use one merge lane per target branch.
- Decouple event fan-out from the merge coordinator.
- Keep the strongly consistent part as small as possible.

### Repository topology

If Artifacts repository size or Git traffic becomes problematic:

- Use session fork repositories.
- Reduce push frequency while preserving durable checkpoints.
- Prune stale branches more aggressively.
- Evaluate external-source mode.
- Evaluate ArtifactFS for large-repository startup, with measured FUSE trade-offs.

### Multi-account or regional deployment

Only consider this after telemetry demonstrates that a single Cloudflare account, namespace,
region/jurisdiction, or resource envelope cannot meet the enterprise profile. A multi-account design
would require explicit routing, identity, data residency, billing, and disaster-recovery decisions.

## 10. Pilot acceptance criteria

Before claiming enterprise readiness, the pilot should be able to report:

1. Peak and p95 active users, sessions, Containers, previews, and WebSocket connections.
2. Resource consumption by instance type and project.
3. Container start, restore, stop, and snapshot distributions.
4. Model usage and estimated spend by project/session/model.
5. Artifacts repository sizes, branch counts, Git operation rates, and rate-limit events.
6. ProjectDO request/latency distributions and merge queue behaviour.
7. Preview and terminal connection/reconnect behaviour.
8. Error rates and recovery outcomes after Worker deployments.
9. At least one capacity incident drill with dashboards and alerts.
10. A documented recommendation for whether the current architecture is sufficient, or which
    specific scaling change is justified by observed data.

The output of this phase should be a measured capacity report, not an assumption that 2,000 users
means 2,000 simultaneous full-size development environments.
