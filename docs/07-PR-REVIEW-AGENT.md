# Demo 7: PR Review Agent

Directory: `demos/review-agent`

Domain: `review-agent.cfapps.uk`

Status: Draft implementation plan

Cloudflare products: Workers, Static Assets, Cloudflare Access, D1, Durable
Objects (Agents SDK), Workers AI, and AI Gateway.

## Goal

Using agentic AI, provide a PR (Pull Request) / MR (Merge Request) review
agent for GitHub and GitLab, covering software architecture, code quality,
accessibility, and security. When a review finishes, the consolidated result
is posted as a single comment on the originating PR/MR, and the full
structured report remains available in this demo's own UI. A review can be
triggered either by a webhook from GitHub/GitLab or by an authenticated user
pasting a PR/MR URL into the UI. While a review is running, the UI shows what
each reviewer is doing and, once available, what it cost.

This is the curriculum's introduction to two things every earlier demo
sidesteps: **consuming a signed, unauthenticated-by-Access inbound webhook
from a third-party SaaS platform**, and **running several independent AI
passes over the same input and merging their structured output into one
report**. Every primitive it uses to do that — Workers AI, AI Gateway,
Durable Objects, and the Agents SDK's `state`/`broadcast()` live-update
mechanism — was already taught by demo 5 or demo 6; this demo does not
introduce a new Cloudflare product for its own sake, only a new way of
combining ones already in the curriculum.

## Prior Art

- <https://github.com/adrianhall/opencode-setup> — a set of OpenCode agents
  that perform this same kind of review as local subagents, run against a
  checked-out PR from a terminal. This repository's own `/review` command
  and its four subagents
  (`~/.config/opencode/agents/{code-reviewer,security-reviewer,software-architect-reviewer,accessibility-reviewer}.md`,
  orchestrated by `~/.config/opencode/agents/review-orchestrator.md`) are the
  same lineage and are the direct model for this demo's four reviewer
  personas and its severity/merge rules — see "Reviewer Personas And
  Structured Findings" below for exactly what is reused and what is
  deliberately simplified for a Workers runtime.
- [`reviewbot-agent`](../../reviewbot-agent/) — a "lab" reviewbot built on the
  Agents SDK's `AIChatAgent`, triggered by chat rather than a webhook, from
  the lab at <https://agents-school.tiwi.me>. It confirms the
  `workers-ai-provider` + `ai` SDK + Agents SDK combination this demo also
  uses, but is chat-shaped (one conversational agent, no external Git
  integration, no structured findings). This demo is not a chat agent: a
  review run has a fixed start, a fixed set of parallelizable-in-principle
  steps, and a fixed end, which is why it uses a plain Agents SDK `Agent`,
  not an `AIChatAgent` (see "Review Orchestration").

## Behavior

- Accept exactly two trigger mechanisms that converge on the same
  orchestration path immediately after normalization:
  - An inbound webhook from GitHub (`pull_request` event, actions `opened`,
    `synchronize`, `reopened`) or GitLab (`Merge Request Hook`, actions
    `open`, `update`, `reopen`), each verified using that provider's own
    signing mechanism (see "Git Provider Integration").
  - An authenticated user pasting a PR or MR URL into a form in the UI.
- Normalize either trigger into the same `{ provider, repoFullName,
  prNumber, headSha }` record, then fetch that PR/MR's unified diff and
  changed-file list from the provider's REST API, capped in size and file
  count as a cost/abuse control (see "Git Provider Integration" for the
  exact caps — document their values in `README.md`, per this repo's
  convention for demo 5's message caps).
- Run up to four specialist reviewer passes — **Architecture**, **Code
  Quality**, **Security**, **Accessibility** — against that diff, each an
  independent Workers AI call through AI Gateway with its own persona and
  its own small toolset (a `getFileContent` tool for pulling more context
  than the diff hunk shows). The Accessibility pass is skipped (not run,
  not billed) when no changed file has a UI-relevant extension, mirroring
  the same rule the real `accessibility-reviewer` subagent already applies.
- Merge the (up to four) reviewers' structured findings into one
  consolidated report with a severity-based executive summary, in the same
  P0–P3 shape the OpenCode `review-orchestrator` produces — deterministically
  in TypeScript, not through a fifth model call (see "Reviewer Personas And
  Structured Findings").
- Post that consolidated report — trimmed to its executive summary and
  P0/P1 findings, with a link back to the full report — as a single comment
  on the originating PR/MR through the provider's REST API.
- Persist the full structured report (every finding, every reviewer's raw
  output, per-reviewer cost/token usage) in D1, and let a signed-in user
  browse a paginated history of past runs and open any run's full report.
- While a run is in progress, push each reviewer's status
  (`queued`/`running`/`done`/`skipped`/`error`) and, once available, its
  cost to any client with that run open — over the same Durable Object
  `state` + `broadcast()` mechanism demo 6 established for a live cost
  ledger, reused here for a fixed four-step pipeline instead of an
  open-ended chat.

## Explicit Exceptions

This demo intentionally narrows or inverts the repository-wide baseline in
the following ways. These exceptions control for this demo only:

- **`.dev.vars` is not committed.** Every other demo's `.dev.vars` holds only
  non-secret local overrides and is committed with a comment explaining why.
  This demo's local development story genuinely needs the operator's own
  GitHub/GitLab personal access tokens and webhook secrets to exercise
  provider-calling code end to end, so — per AGENTS.md's own conditional
  ("commit it only when it holds no secrets") — `.dev.vars` is gitignored
  here. A committed `.dev.vars.example` documents every required key with a
  placeholder value; `README.md` tells the operator to copy it and fill in
  their own tokens.
- **The Access application layout is inverted from AGENTS.md's canonical
  example.** The canonical shape is "public bypass by default, a narrower
  `allow` application for protected paths." This demo needs the opposite
  emphasis — everything is authenticated by default because triggering a
  review is billable AI compute, and only the two webhook endpoints must be
  reachable by GitHub/GitLab with no Access identity at all. So the
  hostname-wide application uses an `allow` policy, and a second,
  more-specific application scoped to exactly `/api/webhooks/github` and
  `/api/webhooks/gitlab` carries the `bypass` policy. This is the same
  "Access routes to the most specific matching application" rule AGENTS.md
  already documents, applied with the default and the exception swapped —
  see "Access Model".
- **No GitHub App or GitLab OAuth application.** A single operator-provided
  personal access token per provider reads diffs/files and posts comments.
  This is simpler to set up for a demo, at the cost of realism a production
  integration would want (a proper GitHub App installation token scoped
  per-repository, not one PAT with blanket access to everything it can see).
  State this trade-off in `EXPLAIN-DEMO.md`.
- **No real static analysis.** The real `security-reviewer` subagent this
  demo is modeled on refuses to run at all unless `semgrep`/`codeql` are on
  `PATH` — tools a Workers isolate cannot exec. Every reviewer pass here,
  security included, is LLM analysis of the diff (plus whatever the
  `getFileContent` tool pulls in), never real SAST. Say so plainly in
  `EXPLAIN-DEMO.md` as a deliberate, load-bearing limitation, not an
  oversight — a production version of this idea would run that stage in a
  container or CI job instead (a natural pointer to demo 8's Sandbox
  SDK/Containers lesson, without this demo needing to implement it).
- **The merge/dedupe step is deterministic code, not a model call.** The
  real `review-orchestrator` uses judgment (an LLM reading every reviewer's
  raw Markdown) to decide when two findings share a root cause and whether
  to promote/demote a severity. This demo's merge step only merges findings
  that share an exact `(filePath, lineNumber)` pair across reviewers and
  never overrides the default severity→priority mapping. This is simpler,
  deterministic, unit-testable, and free — and a smaller, less
  human-like version of that same lesson. Document the difference; do not
  pretend the two are equivalent.
- **No Workflows.** A single Durable Object running a fixed, four-step
  sequential pipeline is sufficient (see "Review Orchestration"); per the
  curriculum principle, do not reach for a Workflow when a Durable Object
  already provides the coordination this needs.

## Out Of Scope

Auto-fixing, auto-committing, or merging anything — this demo only ever
reads a diff and posts a comment. Re-reviewing automatically on every
subsequent push beyond the triggering webhook event (each webhook delivery
that matches a tracked action starts one full review of the PR/MR's current
head, not an incremental diff of only the newest commits). Self-hosted
GitHub Enterprise. GitLab support beyond a configurable base URL for a
self-managed instance. Rate limiting or spend limits at the AI Gateway
level (demo 6 owns that lesson). AI Gateway dynamic routing (also demo 6;
see "Cost Tracking" for why this demo does not need it). Any client-visible
model picker (the reviewer→model mapping is a fixed, server-only
implementation detail, never exposed to the browser). Multi-tenant
isolation of review history — like `demos/swapi-graphql`, every
authenticated identity can see every past run; there is no per-user or
per-team scoping.

## Demo Flow

1. Configure a webhook on a real GitHub repository pointing at
   `https://review-agent.cfapps.uk/api/webhooks/github`, content type
   `application/json`, the configured shared secret, and the `Pull requests`
   event only.
2. Open a pull request in that repository. Within moments, the run appears
   in the (authenticated) UI's history list with status "running" — no
   manual step was needed to start it.
3. Open that run's detail page and watch each reviewer's badge move
   `queued` → `running` → `done` one at a time, and its cost move from
   "pending" to a real dollar figure as AI Gateway confirms it.
4. When the run completes, open the GitHub PR and show the posted review
   comment: an executive summary, a severity table, and the P0/P1 findings,
   with a link back to the full report.
5. Back in the UI, open the full report and show every finding (including
   the P2/P3 ones the comment omitted) and each reviewer's raw output.
6. Demonstrate the second trigger path: paste a GitLab MR URL into the
   "Review a PR/MR" form and submit — no webhook configuration needed for
   this path at all.
7. Open Workers Logs and find the structured `review_started`,
   `reviewer_completed`, `reviewer_skipped`, and `review_posted` events for
   one run, correlated by `runId`, and point out that no diff or finding
   text appears in any of them.
8. Open the AI Gateway dashboard for this demo's gateway and show the
   individual model calls for that run's reviewers, their real cost, and
   point out that it matches the number the UI now shows as "confirmed."

## Relevant Skills

**Cloudflare / backend skills:**

- `cloudflare`
- `cloudflare-one`
- `cloudflare-terraform-best-practices`
- `cloudflare-deploy-scripts`
- `cloudflare-toolkit`
- `workers-best-practices`
- `wrangler`
- `durable-objects`
- `agents-sdk`

**Vue / UI skills:**

- `vue-best-practices`
- `vue-pinia-best-practices`
- `vue-router-best-practices`
- `vue-testing-best-practices`
- `web-perf`

Skills do not replace current documentation. Re-verify the exact GitHub and
GitLab REST endpoints used below (both have changed shape across API
versions — GitLab's merge-request diff endpoint in particular), the current
`cloudflare_ai_gateway` Terraform schema, and the Workers AI/AI Gateway
binding behavior cited from `docs/DECISIONS.md` before relying on any of it
unverified.

## Access Model

Two Cloudflare Access self-hosted applications on one hostname, following
AGENTS.md's "Access routes to the most specific matching application" rule
with the default and the exception inverted from its canonical example (see
"Explicit Exceptions"):

- **`review-agent` (default, whole hostname).** One
  `cloudflare_zero_trust_access_application` with `domain =
  "review-agent.cfapps.uk"` and no `destinations` restriction, backed by an
  `allow` policy for any authenticated identity
  (`include = [{ everyone = {} }]`) — the same shape
  `demos/swapi-graphql` uses, chosen because triggering a review spends real
  AI Gateway budget and every past run's contents are otherwise readable by
  anyone who reaches the hostname. `README.md` MUST document how to narrow
  this (specific emails, an email domain, or a group) for an operator who
  wants stricter cost control, exactly as demo 5 does for its own inference
  endpoint.
- **`review-agent-webhooks` (exception, two exact paths).** A second
  application on the same `domain`, scoped with explicit `destinations`
  entries for `/api/webhooks/github` and `/api/webhooks/gitlab` only,
  backed by a `bypass` policy
  (`decision = "bypass"`, `include = [{ everyone = {} }]`). Access routes a
  request to whichever application's match is more specific, so these two
  exact paths bypass Access entirely — GitHub and GitLab cannot present an
  Access identity — while every other path, including everything else
  under `/api/*`, falls through to the hostname-wide `allow` application
  above. Verify the exact `destinations` object shape (`type`/`uri`, or
  whatever the pinned provider version calls it) against the current
  `cloudflare_zero_trust_access_application` schema before implementing;
  AGENTS.md's own canonical example already establishes the pattern this
  demo copies, just with the two applications' roles swapped.
- A `bypass` policy issues no Access identity JWT. `cloudflareAccess()`
  therefore MUST NOT run on the two webhook paths — the real security
  boundary there is each provider's own signature/token verification inside
  the handler (see "Git Provider Integration"), not Access. `src/worker/access-policies.ts`
  encodes this as the toolkit's `PathPolicy[]`, most-specific-first, exactly
  matching the two Access applications above:

  ```ts
  export const accessPolicies: PathPolicy[] = [
    { pattern: /^\/api\/webhooks\//, authenticate: false },
    { pattern: /^\/api\//, authenticate: true },
    { pattern: /^\/agents\//, authenticate: true },
    { pattern: /^\//, authenticate: true },
  ];
  ```

- `cloudflareAccessPlugin()` in `vite.config.ts` takes the same array, so
  local dev matches production: the webhook paths need no dev sign-in at
  all (a local `curl`/test script can POST directly), and every other path
  — the whole SPA shell included, since `run_worker_first` covers `/api/*`
  and `/agents/*` but not `/` — prompts the plugin's local login form.
- Every authenticated route derives the caller's email from the verified
  Access identity for the `triggeredByEmail` audit column only (Section
  "Data Model"); there is no per-user authorization or data isolation on
  top of it, matching `demos/swapi-graphql`'s "Access is authentication,
  not application-level authorization" stance for this demo's shared,
  team-visible review history.
- Give the UI an unconditional control navigating to
  `/cdn-cgi/access/logout`, per the baseline Public Access guidance.

## Git Provider Integration

`src/worker/providers/` defines one shared interface,
`GitProviderClient`, and one module per provider (`github.ts`, `gitlab.ts`)
implementing it — the same "one small interface, one file per
implementation" shape `src/worker/chat/adapters/` uses in demo 5 for
model-shape heterogeneity, applied here to provider-API heterogeneity
instead:

```ts
interface GitProviderClient {
  parsePrUrl(url: string): PrReference | null;
  verifyWebhook(request: Request, rawBody: string): Promise<WebhookEvent | null>;
  fetchDiff(ref: PrReference): Promise<{ diff: string; changedFiles: string[]; truncated: boolean }>;
  getFileContent(ref: PrReference, path: string): Promise<{ content: string; truncated: boolean } | null>;
  postComment(ref: PrReference, body: string): Promise<{ url: string }>;
}
```

- **Webhook verification.** GitHub signs the raw request body with
  HMAC-SHA-256 and the shared `GITHUB_WEBHOOK_SECRET`, sent as
  `X-Hub-Signature-256: sha256=<hex>`; verify with `crypto.subtle` and a
  timing-safe comparison, never a plain `===` on the hex digest. GitLab
  instead sends the shared `GITLAB_WEBHOOK_SECRET` verbatim as
  `X-Gitlab-Token`; compare it timing-safely against the configured value.
  Reject with `401` (no Access identity is present to blame this on) on any
  mismatch, and log a `webhook_rejected` event with the provider and reason
  but never the raw body or the secret.
- **Idempotency.** Store `(provider, deliveryId)` — GitHub's
  `X-GitHub-Delivery` header; GitLab has no equivalent header, so use
  `object_attributes.id` + `object_attributes.updated_at` instead — in a
  small D1 table before starting a run, so a provider's webhook retry
  cannot start a second review. Separately, `review_runs` has a `UNIQUE
  (provider, repo_full_name, pr_number, head_sha)` constraint; a conflict
  there (the manual UI trigger and a webhook racing for the same commit, or
  a legitimate provider retry after the delivery-id row expired) returns
  the existing run instead of erroring — the same idempotent-upsert
  philosophy demo 6 uses for its admin bootstrap.
- **Diff and file fetching, with cost caps.** GitHub:
  `GET /repos/{owner}/{repo}/pulls/{number}/files` (paginated; each entry's
  `patch` field is the per-file unified diff); GitLab:
  `GET /projects/{id}/merge_requests/{iid}/diffs` (paginated; verify this
  against the current GitLab REST API version — the older
  `.../changes` endpoint is deprecated). Concatenate per-file patches up to
  a documented character cap (for example 60,000 characters, matching
  demo 5's message-length caps in spirit) and a documented file-count cap
  (for example 40 files), skip common generated/lockfile paths by a simple
  filename heuristic (`package-lock.json`, `*.lock`, `pnpm-lock.yaml`, …)
  before counting toward either cap, and record `diffTruncated`/
  `changedFileCount` on the run so the UI and the posted comment can say so
  honestly rather than silently reviewing a partial diff.
- **`getFileContent`.** GitHub:
  `GET /repos/{owner}/{repo}/contents/{path}?ref={headSha}` (base64
  content); GitLab: `GET /projects/{id}/repository/files/{path}?ref={headSha}`
  (also base64). Cap returned content (for example 20,000 characters) and
  return `null` for a path outside the PR/MR's own repository — this tool
  reads only files already implicated by the diff's file list, never an
  arbitrary caller-supplied repository.
- **Comment posting.** GitHub:
  `POST /repos/{owner}/{repo}/issues/{number}/comments` (PR comments use the
  Issues comments endpoint); GitLab:
  `POST /projects/{id}/merge_requests/{iid}/notes`. Both return the created
  comment/note's URL, stored on `review_runs.comment_url`.
- Authentication is a plain bearer/`PRIVATE-TOKEN` header built from
  `env.GITHUB_TOKEN`/`env.GITLAB_TOKEN` (Wrangler secrets — see "Third-party
  credentials" under Implementation Plan Phase 1). There is no Cloudflare
  binding for either provider's API, so this is a deliberate, narrow
  exception to "prefer bindings over REST calls" — there is nothing to bind
  to.
- Every method in both provider modules is a pure function of its inputs
  plus an injected `fetch`, so Phase 3's unit tests substitute a scripted
  `fetch` and never make a real network call.

## Reviewer Personas And Structured Findings

Four reviewer roles, each condensed from the matching local OpenCode
subagent (`~/.config/opencode/agents/*.md`) into a system prompt plus a
shared, machine-parseable output contract — deliberately not the free-form
Markdown tables the real subagents produce for a human, since this Worker
needs to store rows in D1 and merge across reviewers in code, not read
prose:

| Role | Condensed from | Model tier | Skipped when |
| --- | --- | --- | --- |
| `architecture` | `software-architect-reviewer` | deep | never |
| `security` | `security-reviewer` (manual-inspection checklist only — no Semgrep/CodeQL, see "Explicit Exceptions") | deep | never |
| `code-quality` | `code-reviewer` | fast | never |
| `accessibility` | `accessibility-reviewer` | fast | no changed file has a UI-relevant extension (`.vue`, `.tsx`, `.jsx`, `.html`, `.astro`, `.css`, `.scss`) |

- **Model tiers, not a client-visible catalog.** `src/models.ts` exports
  exactly two server-only model descriptors — `fast` and `deep` — never
  imported by client code. Start from demo 5's already-verified catalog:
  `@cf/ibm-granite/granite-4.0-h-micro` for `fast`, `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`
  for `deep`. Both are called by **literal model ID**, not a dynamic route —
  see "Cost Tracking" for why that choice matters here.
- **Output contract.** Every persona's system prompt ends with an explicit
  instruction to reply with prose first (for a human reading the raw
  output) and then exactly one fenced `json` code block containing an array
  matching:

  ```ts
  interface RawFinding {
    findingRef: string; // e.g. "ARCH-001", unique within this reviewer's own output
    severity: "critical" | "high" | "medium" | "low";
    category: string;
    filePath: string | null;
    lineNumber: number | null;
    finding: string;
    recommendation: string;
  }
  ```

  Parse the fenced block and validate it with a `zod` schema. On a parse or
  validation failure, send one corrective follow-up turn ("Your last
  response's JSON was invalid: `<error>`. Return ONLY the corrected JSON
  array, no prose.") and accept or fail after that single retry — bounded,
  so one uncooperative model cannot loop. This convention (fenced JSON in
  an otherwise ordinary chat completion, not provider-native structured
  output/JSON mode) is deliberate: demo 5 already found Workers AI models do
  not share one structured-output capability, so this demo does not assume
  one either.
- **The `getFileContent` tool.** Every reviewer gets the same one tool,
  wired through the `ai` SDK's tool-calling (`workers-ai-provider` +
  `generateText`, mirroring `reviewbot-agent`'s own `streamText` usage but
  non-streaming — nothing here streams to a browser). Bound with
  `stopWhen: stepCountIs(4)` (three tool calls plus a final answer) so one
  reviewer pass cannot run away in cost the way an unbounded agent loop
  could.
- **Severity → priority mapping**, reused verbatim from
  `review-orchestrator`: `critical → P0`, `high → P1`, `medium → P2`,
  `low → P3`. Unlike the real orchestrator, this demo never overrides this
  mapping with judgment (see "Explicit Exceptions").
- **Merge/dedupe**, a pure `mergeFindings(perReviewerFindings):
  MergedFinding[]` function: two findings from different reviewers merge
  into one row only when they share an identical, non-null `(filePath,
  lineNumber)` pair; the merged row's priority is the higher (numerically
  lower) of the two, its `findingRef` is the higher-priority contributor's
  ref with a `+` suffix, and `mergedFrom` records both roles. Sort the
  final list by priority, then role (`architecture, security, code-quality,
  accessibility`), then `filePath`, matching `review-orchestrator`'s own
  sort rule.
- Verify, during Phase 4, that both chosen models reliably produce parseable
  JSON in this fenced-block convention against a real deployed account,
  the same way demo 5 spiked its catalog before committing to it; correct
  the model tiers above if not, and record the outcome in
  `docs/DECISIONS.md`.

## Review Orchestration

One `ReviewRunAgent extends Agent<Env, ReviewRunState>` (Agents SDK, plain
`Agent`, not `AIChatAgent` — there is no open-ended conversation here, only
a fixed pipeline with a start and an end) per review run, addressed by
`getAgentByName(env.REVIEW_RUN, runId)` where `runId` is a
`crypto.randomUUID()` minted the moment a trigger is accepted (webhook or
manual). This gives the run:

- **A persistent connection for live status**, which is the concrete
  "coordination/persistent connection" justification the curriculum
  principle asks for before reaching for a Durable Object: a client with a
  run's detail page open holds a WebSocket to this instance for the
  run's lifetime.
- **A natural place to hold in-memory sequencing** for the pipeline below,
  without any extra locking.

```ts
interface ReviewRunState {
  runId: string;
  status: "running" | "completed" | "failed";
  reviewers: Array<{
    role: ReviewerRole;
    status: "queued" | "running" | "done" | "skipped" | "error";
    costUsd: number | null;
    costSource: "pending" | "gateway";
    findingCount: number;
  }>;
}
```

A `@callable() start(payload: ReviewTrigger)` RPC (called once, immediately
after the D1 `review_runs` row is inserted) does the minimum to answer
quickly — per the Agents SDK's own webhook guidance to "respond quickly" —
then hands off to `this.ctx.waitUntil(this.runPipeline(payload))` so the
triggering HTTP request (the webhook delivery, or the UI's `POST
/api/reviews`) returns as soon as the run is accepted, not after it
finishes.

`runPipeline()`:

1. `setState()` every reviewer to `queued` (skip `accessibility` immediately
   if no changed file qualifies) and broadcast nothing yet — the initial
   state itself is what a client connecting right away receives.
2. Fetch the diff via the matching `GitProviderClient`. On failure, write
   `review_runs.status = "failed"` with an error detail, `setState({status:
   "failed"})`, and stop — no reviewer ever ran, so there is nothing to bill
   or reconcile.
3. **Run the (up to four) active reviewers strictly sequentially, not in
   parallel.** This is a deliberate choice, not an oversight, for two
   independent reasons:
   - `env.AI.aiGatewayLogId` documents itself as "the log ID from the most
     recent `env.AI.run()` request" — a single value on the shared binding.
     Reading it immediately after each `await env.AI.run(...)` call, before
     the next one starts, is unambiguous; racing several calls with
     `Promise.all` would not be. Running sequentially sidesteps that
     question entirely instead of needing to prove it safe.
   - It gives a presenter a legible, one-at-a-time story to narrate live —
     "now architecture is running, now security…" — which a set of four
     simultaneously-flipping badges would not.

   For each active reviewer, in a fixed order (`code-quality`,
   `accessibility`, `architecture`, `security` — cheaper/faster passes
   first): `setState` that reviewer to `running` and `broadcast()` a
   `{ type: "reviewer_started", role }` event; run its persona (see
   "Reviewer Personas"); on success, write its `review_findings` rows and a
   `review_reviewers` row with `costSource: "pending"` and the call's
   `aiGatewayLogId`; `setState` it to `done`, `broadcast()`
   `{ type: "reviewer_completed", role, findingCount }`; and `this.schedule(5,
   "reconcileCost", { reviewerRowId, logId })` (see "Cost Tracking"). On
   failure (including exhausting the one JSON-repair retry), write
   `status: "error"` with the error detail instead and continue to the next
   reviewer — one reviewer failing must not abort the whole run.
4. Once every active reviewer has finished (successfully or not), call the
   pure `mergeFindings()` function, assemble the consolidated Markdown
   report (see "Report Assembly And Comment Posting"), and post it. Update
   `review_runs` with `status: "completed"`, `commentUrl`, `completedAt`;
   `setState({status: "completed"})`; `broadcast()`
   `{ type: "review_completed", commentUrl }`.
5. `reconcileCost(payload)` (an Agents SDK scheduled task, not
   `ctx.waitUntil`, since it must survive independently of the request that
   scheduled it): call `env.AI.gateway(env.AI_GATEWAY_ID).getLog(logId)`. Per
   `docs/DECISIONS.md` #16, an unavailable log throws `AiGatewayLogNotFound`
   rather than returning `null` — catch it, increment
   `reconcile_attempts`, and reschedule with backoff (5 s, then 15 s, then
   30 s; three attempts total) if under the bound; beyond it, leave the row
   `costSource: "pending"` permanently, a legitimate outcome exactly as
   demo 6 treats an unreconciled turn. On success, read `tokens_in`/
   `tokens_out`/`cost` (the real `AiGatewayLog` field names per
   `docs/DECISIONS.md` #16 — not `prompt_tokens`/`completion_tokens`),
   `UPDATE` the `review_reviewers` row with `costSource: "gateway"`,
   `setState()` that reviewer's `costUsd`/`costSource`, and `broadcast()`
   `{ type: "cost_reconciled", role, costUsd }` so the UI can animate the
   "pending" → confirmed transition the same way demo 6's chat badge does.
6. The reconciliation task MUST tolerate the run having been deleted (there
   is no deletion feature in this demo, but tolerate it anyway per the same
   defensive habit demo 6 documents) — exit cleanly, never throw.

## Cost Tracking

Simpler than demo 6's chat cost ledger, and deliberately so — reusing the
same lesson (AI Gateway's own logged figure is the authoritative number;
compute nothing locally) without reusing its heaviest mechanism:

- **No local pricing-table estimate.** Demo 6 needed an instant, honestly
  labeled `estimated` number because a chat UI's user is actively watching
  each turn. A PR review's reviewer badges already show visible progress
  (`queued`/`running`/`done`) without one; showing `costUsd: null` /
  "pending" between a reviewer finishing and AI Gateway confirming its cost
  (single-digit seconds, per demo 6's own measured lag) is acceptable UX
  here, and it means this demo needs no per-model pricing table at all.
- **`env.AI.gateway(id).getLog(logId)`, not the logs-list REST API.** Demo 6
  had to abandon `aiGatewayLogId`/`getLog()` and build a
  correlation-UUID-against-the-REST-logs-list workaround, needing a
  Wrangler secret for a Cloudflare API token, because every one of its
  calls used a **dynamic route** name as the model argument, which
  `docs/DECISIONS.md` #13 confirms nulls out `aiGatewayLogId` unconditionally.
  This demo never uses a dynamic route — every reviewer call passes a
  **literal model ID** — so `aiGatewayLogId` is populated normally (also
  confirmed in #13), and reconciliation is one binding call,
  `env.AI.gateway(env.AI_GATEWAY_ID).getLog(logId)`, with no REST call, no
  extra Wrangler secret, and no correlation metadata needed at all.
- **No AI Gateway dynamic routing.** Demo 6 owns that lesson (governed,
  metadata-driven model selection). This demo's reviewer→model mapping is a
  fixed server-side implementation detail with no per-caller variation, so
  there is nothing for dynamic routing to govern here — provisioning it
  would just be unused infrastructure.
- Every reviewer's cost and the run's total are shown with the same
  "pending"/"AI Gateway confirmed" distinction demo 6's UI uses, never
  blended into a single ambiguous number.

## Report Assembly And Comment Posting

`src/worker/review/report.ts` builds two representations from the same
`MergedFinding[]` and per-reviewer metadata, so they can never drift:

- **The full report** (stored in D1 as the run's canonical Markdown, and
  what the UI's report page renders): an executive summary, a severity
  count table (P0–P3), the complete findings table, and each reviewer's raw
  prose output under a collapsible section — the same shape
  `review-orchestrator` produces for a human, Section 5 of this document's
  Step 5 output format.
- **The posted comment**: the executive summary and severity table in
  full, then only the P0 and P1 findings (P2/P3 omitted with a one-line "+N
  more findings — see the full report" note), and a link to
  `https://review-agent.cfapps.uk/reviews/{runId}`. This keeps every posted
  comment well under either provider's practical size limits regardless of
  how large a PR's diff was, and matches the scenario's own framing: the
  comment is a pointer to act on quickly, the UI is where the full report
  lives.
- When merged findings list is empty (every reviewer found nothing), post a
  short, honest "no findings" comment rather than an empty table — do not
  manufacture findings to fill the report, per the same tone rule the real
  subagents already follow.

## Data Model

| Table | Purpose | Notable columns |
| --- | --- | --- |
| `review_runs` | One row per review | `id` (UUID PK), `provider`, `repo_full_name`, `pr_number`, `pr_url`, `pr_title`, `pr_author`, `head_sha`, `trigger` (`webhook`\|`manual`), `triggered_by_email` (nullable), `status`, `diff_truncated`, `changed_file_count`, `comment_url` (nullable), `error_detail` (nullable), `created_at`, `completed_at`; `UNIQUE (provider, repo_full_name, pr_number, head_sha)` |
| `review_webhook_deliveries` | Idempotency guard | `id` (`provider:deliveryId`, PK), `run_id` (nullable FK), `received_at` |
| `review_reviewers` | Per-reviewer execution record | `id`, `run_id` FK, `role`, `model`, `status`, `skipped_reason` (nullable), `started_at`, `completed_at`, `error_detail` (nullable), `ai_gateway_log_id` (nullable), `cost_usd` (nullable), `tokens_in`/`tokens_out` (nullable), `cost_source` (`pending`\|`gateway`), `reconcile_attempts` |
| `review_findings` | Merged findings | `id`, `run_id` FK, `finding_ref`, `priority` (`P0`–`P3`), `severity`, `category`, `file_path` (nullable), `line_number` (nullable), `finding`, `recommendation`, `merged_from` (nullable, comma-separated roles) |

`review_runs.status`/`review_reviewers.status` are the same enums the
`ReviewRunState` (Section "Review Orchestration") mirrors; D1 remains the
source of truth for history and reports, `state` is a live projection for
whichever run is currently open — the same division of responsibility demo
6 draws between its `chat_usage` table and `ChatAgent.state.usage`.

## API And Routing

Only `/api/*` and `/agents/*` are in `run_worker_first`; everything else is
the SPA shell served by the `ASSETS` binding's `single-page-application`
fallback, gated by Access at the edge with no Worker route needed:

- `POST /api/webhooks/github` — public (Access-bypassed; see "Access
  Model"). Verifies the signature, parses the event, and — for a tracked
  action — inserts the `review_runs`/`review_webhook_deliveries` rows and
  calls `start()` on the run's agent.
- `POST /api/webhooks/gitlab` — public, the GitLab equivalent.
- `POST /api/reviews` — authenticated. Body `{ url: string }`; parses the
  PR/MR URL with the matching provider's `parsePrUrl()`, then reuses the
  exact same run-creation path as a webhook, with `trigger: "manual"` and
  the caller's verified email recorded.
- `GET /api/reviews` — authenticated. Paginated run history (id, provider,
  repo, PR number/title, status, total cost, created/completed timestamps).
- `GET /api/reviews/:id` — authenticated. Full run detail: reviewer rows,
  merged findings, the full Markdown report, and the posted comment URL.
- `GET /api/me` — authenticated identity, for the header.
- `/agents/review-run/:id` — the Agents SDK's own WebSocket routing
  convention, authenticated, used only while a run's detail page is open.

Everything else is an RFC 9457 problem details response via the toolkit's
`problemDetailsErrorHandler()`/`notFoundHandler()`.

## Implementation Plan

### Phase 1 — Scaffold and baseline infrastructure

1. Create an independent `demos/review-agent` demo using Vue 3, Vuetify,
   Pinia, Vue Router, Vite, Hono, the Agents SDK, and TypeScript, following
   the canonical `demos/url-shortener` layout (`infra/`, `src/worker/`,
   `src/client/`, `tests/integration/`, `README.md`, `DEMO.md`,
   `EXPLAIN-DEMO.md`, `biome.json`, `tsconfig.json`, `vite.config.ts`, root
   `vitest.config.ts`).
2. Provision the baseline resources with Terraform: a Worker (explicit
   `subdomain` block), the `review-agent.cfapps.uk` custom domain (with the
   one-time inert bootstrap version/deployment), a D1 database, an explicit
   `cloudflare_ai_gateway` resource (its own named gateway, not the
   account's `default` one, so its dashboard analytics stay scoped to this
   demo), Workers Logs, and automatic tracing with explicit sampling. Read
   configuration from `../.env` via the `dotenv` provider; set
   `DEMO_NAME=review-agent` and `DEMO_DOMAIN=cfapps.uk`. `depends_on` on the
   Worker MUST include the D1 database (per AGENTS.md's teardown-ordering
   rule); it does not need one for the AI Gateway resource, since the
   gateway ID is a runtime string argument, not a compiled `wrangler.jsonc`
   binding the API refuses to delete out from under a live Worker — say so
   in a comment next to the resource.
3. Commit a single `wrangler.jsonc.tpl` with `{{placeholder}}` markers for
   every Terraform-sourced value (worker name, D1 binding details, the AI
   Gateway id, `cloudflare_team_domain`). Declare `"ai": { "binding": "AI",
   "remote": true }` (Workers AI has no local simulator, exactly as
   `docs/05-AI-CHAT.md` and `docs/DECISIONS.md` #9 already establish for
   this repo), a `"durable_objects"` binding `REVIEW_RUN` →
   `ReviewRunAgent` with a `new_sqlite_classes` migration, `assets` with
   `not_found_handling: single-page-application` and
   `run_worker_first: ["/api/*", "/agents/*"]`, `upload_source_maps: true`,
   `workers_dev: false`, `preview_urls: false`, and a current
   `compatibility_date`. Add `infra/local-outputs.json` with hardcoded
   local values and wire `generate-wrangler -c -l infra/local-outputs.json`
   into `prebuild`/`prestart`/`precheck:types`/`pretest`/`pretest:coverage`/
   `pretest:integration`. Generate binding types from `wrangler.jsonc`.
4. **`.dev.vars` is gitignored for this demo (see "Explicit Exceptions")**.
   Commit `.dev.vars.example` documenting `ENVIRONMENT`, `GITHUB_TOKEN`,
   `GITHUB_WEBHOOK_SECRET`, `GITLAB_TOKEN`, `GITLAB_WEBHOOK_SECRET`, and
   `GITLAB_BASE_URL` (default `https://gitlab.com`) with placeholder
   values; `README.md` tells the operator to copy it locally and fill in
   their own tokens before `vite dev` can exercise provider-calling code.
5. Mirror `demos/ai-chat`'s `package.json` scripts (this demo also has no
   D1 migrations to speak of beyond its own schema) plus `db:migrate:local`/
   `db:migrate:remote` (`CI=1 wrangler d1 migrations apply DB
   --local`/`--remote`) for the schema in "Data Model": `build`, `check:*`,
   `format:*`, `generate:*`, `start`, `test*`, `deploy`
   (`deploy:infra` → `db:migrate:remote` → `deploy:worker`, with
   `predeploy:worker` running `generate-wrangler -cf --terraform infra`
   plus `generate:types`), `teardown`, `postteardown` removing the
   generated `wrangler.jsonc`/`worker-configuration.d.ts`.
6. Write `.env.example` from the baseline permission block, adding
   `Account: D1 - Edit`, `Account: Workers AI - Read`, and
   `Account: AI Gateway - Edit`. This file documents only *Cloudflare* API
   token permissions — the GitHub/GitLab tokens are documented separately
   in `.dev.vars.example` (local) and `README.md` (production secrets, set
   once via `wrangler secret put GITHUB_TOKEN` / `GITHUB_WEBHOOK_SECRET` /
   `GITLAB_TOKEN` / `GITLAB_WEBHOOK_SECRET` after the first deploy — a
   manual, operator-owned step, matching this repo's stance that the
   operator owns third-party credential creation and rotation).

### Phase 2 — Cloudflare Access (mixed public/authenticated hostname)

7. Provision the two `cloudflare_zero_trust_access_application` resources
   from "Access Model": the hostname-wide `allow` application (no email
   allowlist) and the `destinations`-scoped `bypass` application for the
   two webhook paths. Confirm the exact `destinations` schema against the
   pinned provider version first.
8. Add `src/worker/access-policies.ts` (the `PathPolicy[]` array from
   "Access Model") and mount `cloudflareAccess()` once, globally, in
   `src/worker/index.ts`, reading the same array. Do not validate
   `audience` — there is exactly one authenticated identity purpose on this
   hostname (any signed-in user, no per-application replay concern beyond
   what a single application already has).
9. Configure `cloudflareAccessPlugin()` in `vite.config.ts` with the same
   array, `users` matching `.env.example`'s operator identity conventions,
   and development tokens gated on `import.meta.env.DEV`. Confirm the
   webhook paths need no dev sign-in by curling them directly against
   `vite dev`. Render the unconditional `/cdn-cgi/access/logout` control.

### Phase 3 — Git provider integration (no AI yet)

10. Implement `src/worker/providers/github.ts` and `gitlab.ts` against the
    shared `GitProviderClient` interface from "Git Provider Integration":
    `parsePrUrl()`, `verifyWebhook()` (HMAC-SHA-256 for GitHub, timing-safe
    token compare for GitLab), `fetchDiff()` (with the documented
    character/file-count caps and generated-file skip list),
    `getFileContent()` (with its own cap), and `postComment()`. Every
    method takes an injected `fetch` so it never makes a real network call
    from a unit test.
11. Implement the webhook idempotency guard (`review_webhook_deliveries`)
    and the `review_runs` idempotent-insert-or-return-existing helper
    (`UNIQUE (provider, repo_full_name, pr_number, head_sha)`).
12. Implement `src/worker/routes/webhooks.ts` (mounted before
    `cloudflareAccess()` needs to run, per the bypass policy — verify no
    Access identity is expected on this path anywhere in the handler) for
    both providers: verify → parse → dedupe → insert run → call
    `getAgentByName(env.REVIEW_RUN, runId).start(payload)` → respond `202`
    quickly. Log `webhook_received`/`webhook_rejected`/`review_started`,
    never the raw payload.
13. Unit-test every provider method (valid/invalid signatures, valid/
    invalid tokens, pagination, the character/file caps actually
    truncating, the generated-file skip list, comment body construction)
    and the idempotency helpers, entirely without AI or a Durable Object.

### Phase 4 — Reviewer personas, structured findings, and orchestration

14. Add `src/models.ts`: the two server-only model descriptors (`fast`,
    `deep`) from "Reviewer Personas And Structured Findings", typed against
    the generated `AiModels` keys. Never imported by `src/client/`.
15. Add `src/worker/review/personas/` — one module per role
    (`architecture.ts`, `security.ts`, `code-quality.ts`,
    `accessibility.ts`), each exporting its condensed system prompt (see
    the table's "Condensed from" column) and its model tier. Add
    `src/worker/review/schema.ts`: the `RawFinding` zod schema and the
    fenced-JSON-block parser (extract, `JSON.parse`, validate), covering
    the one-retry repair path from "Reviewer Personas And Structured
    Findings".
16. Implement `src/worker/review/getFileContentTool.ts`: the `ai` SDK tool
    definition wrapping `GitProviderClient.getFileContent()`, taking the
    provider client as a parameter so tests can substitute one.
17. Implement `src/worker/review/runReviewer.ts`: given a persona, a diff,
    the changed-file list, and a `GitProviderClient`, run
    `workers-ai-provider` + `generateText` with the `getFileContent` tool
    and `stopWhen: stepCountIs(4)`, parse the fenced JSON block, and return
    `{ findings: RawFinding[], rawOutput: string, aiGatewayLogId: string |
    null }`. Verify against the deployed account (per "Reviewer Personas
    And Structured Findings") that both model tiers reliably produce
    parseable output; record the outcome in `docs/DECISIONS.md`.
18. Implement `src/worker/review/merge.ts`: the pure `mergeFindings()`
    function and its severity→priority mapping, unit-tested against every
    dedupe/sort rule in "Reviewer Personas And Structured Findings"
    (including the "no override" rule — confirm a `critical` finding never
    becomes anything but `P0`).
19. Implement `src/worker/agents/ReviewRunAgent.ts`: the `Agent<Env,
    ReviewRunState>` from "Review Orchestration" — `start()`, the
    sequential `runPipeline()` (fixed reviewer order, per-reviewer
    `setState`/`broadcast()`, D1 writes, `this.schedule()` for
    reconciliation), and `reconcileCost()` (catching
    `AiGatewayLogNotFound`, the three-attempt backoff, tolerating a
    since-deleted run). Never accumulate a reviewer's full raw output in a
    variable that outlives its own D1 write.
20. Implement `src/worker/review/report.ts`: `buildFullReport()` and
    `buildCommentBody()` from "Report Assembly And Comment Posting",
    sharing the same `MergedFinding[]` input so they cannot drift, and the
    "no findings" honest-empty-report path.
21. Emit `reviewer_started`, `reviewer_completed`, `reviewer_skipped`,
    `reviewer_failed`, and `review_posted` structured logs via
    `cloudflareLogger()`, placed after Access/validation guards, carrying
    role, model, duration, and finding/token counts — never diff text,
    finding text, or a provider token.

### Phase 5 — API routes

22. Implement `src/worker/routes/reviews.ts`
    (`POST /api/reviews`, `GET /api/reviews`, `GET /api/reviews/:id`) and
    `src/worker/routes/me.ts`, mounted from `src/worker/index.ts` (routing
    only), with `src/worker/bindings.ts` as the single
    `AppBindings`/`AppVariables` definition and the toolkit's Hono error
    handler for problem details.
23. Implement the D1 repository layer (`src/worker/data/*.ts`) backing
    "Data Model" — one function per query, never `SELECT *`, thin mappers
    to camelCase domain objects, reused by both the webhook route and the
    manual-trigger route so they share one run-creation code path exactly
    as "Behavior" requires.

### Phase 6 — Browser application

24. Build a focused Vue 3 + Vuetify UI meeting WCAG 2.2 AA on desktop and
    mobile:
    - A "Review a PR/MR" form (a single URL field, validated client- and
      server-side) that posts to `POST /api/reviews` and navigates to the
      new run's detail page.
    - A paginated history list (`GET /api/reviews`): repo, PR/MR title,
      status, total cost, timestamps, linking to each run's detail page.
    - A run detail page: four reviewer status badges (or three, when
      accessibility was skipped — show why, not just its absence), each
      showing its live status and cost via the `useReviewRun` composable
      below; once the run completes, the full report (executive summary,
      severity table, findings table, each reviewer's raw output in a
      collapsible panel) and the posted comment's link.
    - The verified identity and an unconditional `/cdn-cgi/access/logout`
      control in the header.
    - Accessibility specifics: live-region announcements for reviewer
      status transitions without re-announcing the whole page on every
      update; labeled controls; keyboard-operable throughout; meet
      target-size and contrast requirements.
25. Add `src/client/composables/useReviewRun.ts`, a small, framework-
    agnostic-`AgentClient`-backed Vue composable (following this repo's
    `create-adaptable-composable` conventions and demo 6's
    `useChatAgent` precedent) that connects to `/agents/review-run/:id`,
    exposes the run's `state` as a reactive ref, and surfaces the
    `reviewer_started`/`reviewer_completed`/`cost_reconciled`/
    `review_completed` broadcast events as a typed stream for the badge
    transition animations.
26. Manage state in Pinia: a `session` store (identity) and a `reviews`
    store (history list, the currently open run's static detail once
    fetched via REST, merged with `useReviewRun`'s live fields). Keep
    `src/client/main.ts` bootstrap-only with `App.vue`, `views/`,
    `stores/`, `components/`.

### Phase 7 — Tests, deployment, and documentation

27. Add the three Vitest projects from a root `vitest.config.ts`:
    - `src/worker/vitest.config.ts` (`environment: node`, `name: worker`):
      every provider-client method (Phase 3), the fenced-JSON parser and
      its one-retry repair path, `mergeFindings()`'s dedupe/sort/no-override
      rules, `buildFullReport()`/`buildCommentBody()` (including the
      "no findings" path and the P2/P3-omitted comment truncation), and the
      structured-log field guarantees (no diff/finding/token content).
    - `src/client/vitest.config.ts` (`environment: jsdom`, `name: client`,
      `@vitejs/plugin-vue`): the trigger form's validation, the history
      list, the run detail page's badge states fed a synthetic
      `useReviewRun` stream (including a `reviewer_failed` and a
      `cost_reconciled` transition), and the report renderer.
    - `tests/integration/vitest.config.ts` (`@cloudflare/vitest-pool-workers`,
      `configPath` resolved from `import.meta.dirname`,
      **`remoteBindings: false`**, with a comment explaining that the `ai`
      binding would otherwise force a credentialed remote proxy session —
      the same reasoning as `docs/05-AI-CHAT.md`). Drive the Hono app
      directly (`app.fetch(request, env, ctx)`) with an injected fake `Ai`
      returning scripted fenced-JSON completions and a `GitProviderClient`
      test double, per this repo's established pattern for a
      no-local-simulation binding.
28. Integration tests MUST cover, end to end in real `workerd`: an
    unauthenticated `POST /api/reviews` (blocked) alongside an
    unauthenticated `POST /api/webhooks/github` with a valid signature
    (allowed — proving the bypass application's intent is faithfully
    reproduced in the access-policy array); a rejected webhook with an
    invalid signature/token; a full run from webhook trigger through all
    four reviewers (including one scripted to fail and one skipped for
    having no UI files) to a posted comment and a `completed` D1 row; the
    manual-trigger path producing the identical D1 shape as the webhook
    path; a duplicate webhook delivery being a no-op against the
    idempotency guard; and `getLog()` reconciliation both succeeding and
    exhausting its retry bound (asserting the row is left `pending`
    permanently, not retried forever). Configure
    `@vitest/coverage-istanbul` and `test:coverage`; treat uncovered
    authored source as a gap to close.
29. Provide single-command `npm run deploy` (Terraform init/apply,
    `db:migrate:remote`, `generate-wrangler -cf --terraform infra` +
    `generate:types`, build, `wrangler deploy`) and `npm run teardown`
    (`terraform destroy`), composed from small `package.json` scripts
    chained with `run-s`. A successful teardown leaves no named or
    billable resource behind — the Worker, D1 database, AI Gateway
    resource, and both Access applications.
30. Write `README.md` (operator/developer guide: prerequisites including
    a GitHub and/or GitLab personal access token and webhook secret,
    environment configuration split between `.env`/`.dev.vars.example`/
    production secrets, local development and its `.dev.vars` exception,
    testing, the exact one-time `wrangler secret put` commands, exact
    deployment and verification steps — including how to point a real
    repository's webhook at the deployed hostname — troubleshooting, and
    exact teardown), `DEMO.md` (the presenter script from "Demo Flow"),
    and `EXPLAIN-DEMO.md` (what this demo teaches about consuming
    third-party webhooks safely, running several independent AI passes
    and merging them deterministically, why `aiGatewayLogId` works here
    when demo 6 had to work around it, the deliberate LLM-only
    "security review" limitation versus real SAST, and a "Further
    Reading" section). Add JSDoc to every authored TypeScript declaration.
31. Verify formatting, linting, type checking, all three Vitest projects,
    the production build, the generated Wrangler configuration, and
    `terraform fmt -check`/`terraform validate` in `infra`. Do not run
    `terraform apply`, deploy, or destroy real resources, and do not
    register a real webhook against a live repository, unless the
    operator explicitly requests it and provides the environment.
