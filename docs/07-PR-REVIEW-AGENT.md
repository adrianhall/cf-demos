# Demo 7: PR Review Agent

Directory: `demos/review-agent`

Domain: `review-agent.cfapps.uk`

Status: Draft implementation plan

Cloudflare products: Workers, Static Assets, Cloudflare Access, D1, Durable
Objects (Agents SDK), Workflows, Workers AI, and AI Gateway.

## Goal

Using agentic AI, provide a PR (Pull Request) / MR (Merge Request) review
agent for GitHub and GitLab, covering software architecture, code quality,
accessibility, and security. When a review finishes, the consolidated result
is posted as a single comment on the originating PR/MR, and the full
structured report remains available in this demo's own UI. A review can be
triggered either by a webhook from GitHub/GitLab or by an authenticated user
pasting a PR/MR URL into the UI. While a review is running, the UI shows what
each reviewer is doing and, once available, what it cost.

This is the curriculum's introduction to three things every earlier demo
sidesteps: **consuming a signed, unauthenticated-by-Access inbound webhook
from a third-party SaaS platform**; **running several independent AI passes
over the same input and merging their structured output into one report**;
and — the one genuinely new product this demo brings forward from its usual
curriculum position (demo 14) on purpose — **wrapping an agent's inherently
non-deterministic steps (an LLM call, with tool use, whose output shape and
retry behavior are never fully predictable) inside a Cloudflare Workflow's
deterministic, checkpointed steps**, so a transient failure retries only the
one step that failed — and only that step's one paid model call — instead of
re-running (and re-billing) an entire review. Every other primitive this
demo uses — Workers AI, AI Gateway, Durable Objects, and the Agents SDK's
`state`/`broadcast()` live-update mechanism — was already taught by demo 5 or
demo 6; see "Explicit Exceptions" for why pulling Workflows forward here,
ahead of demo 14, is deliberate rather than a curriculum-ordering mistake.

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
  integration, no structured findings, no Workflow). This demo is not a chat
  agent: a review run has a fixed start, a fixed sequence of steps, and a
  fixed end, which is why the pipeline itself is a Cloudflare Workflow
  (`AgentWorkflow`) and the Agent's own job shrinks to holding the live
  WebSocket connection and reacting to the Workflow's progress (see "Review
  Orchestration"). Neither prior-art repo uses Workflows at all — that part
  of this demo's design has no direct precedent in either.

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
  Quality**, **Security**, **Accessibility** — against that diff, each its
  own durable, independently retried step of one Cloudflare Workflow, an
  independent Workers AI call through AI Gateway with its own persona and
  its own small toolset (a `getFileContent` tool for pulling more context
  than the diff hunk shows). The Accessibility pass is skipped (not run,
  not billed) when no changed file has a UI-relevant extension, mirroring
  the same rule the real `accessibility-reviewer` subagent already applies.
- If one reviewer's call fails transiently (a network blip, a momentary
  Workers AI/AI Gateway error), only that step retries — automatically, with
  backoff, per the Workflow's own step configuration — while every
  already-completed reviewer's findings and cost stay exactly as they were.
  Nothing about a whole review ever needs to restart from the beginning
  because one step had a bad moment (see "Review Orchestration").
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
  ledger, here fed by the owning Workflow's own progress reports rather than
  a hand-rolled sequential loop inside the Agent itself.

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
- **Workflows appear ahead of their curriculum position (demo 14), on
  purpose.** The curriculum principle is "introduce at most one major
  platform concept in each demo" and "do not use a Workflow when a request
  or Queue consumer is sufficient" — and a request or a Durable Object's own
  in-memory sequencing genuinely would be sufficient here in the narrow
  sense of "the pipeline would still run." This demo pulls Workflows forward
  anyway because the user-facing lesson it exists to teach — pairing an
  agent's non-deterministic steps with deterministic, checkpointed,
  automatically retried orchestration — is a different emphasis than demo
  14's own Workflows lesson (a long-running pipeline that waits on an
  external human approval), not a duplicate of it. Demo 14 still introduces
  Workflows as this repo's curriculum sees it first in reading order; this
  demo is the one place it is used for something an agentic system
  specifically needs. Say so explicitly in `EXPLAIN-DEMO.md` so the
  reordering reads as deliberate, not as a curriculum-principle violation.

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
4. Open the Cloudflare dashboard's Workflows view (or, when rehearsing
   locally, Local Explorer at `/cdn-cgi/explorer`) for this run's instance
   and show its step timeline: one step per reviewer, one per cost
   reconciliation, each with its own status and retry count — the same
   pipeline the badges in step 3 are a live projection of. If rehearsing,
   force a transient failure in one reviewer step ahead of time (see
   `DEMO.md` for the exact rehearsal trick) and point out that only that one
   step re-ran — every other reviewer's already-recorded finding and cost
   was untouched by the retry.
5. When the run completes, open the GitHub PR and show the posted review
   comment: an executive summary, a severity table, and the P0/P1 findings,
   with a link back to the full report.
6. Back in the UI, open the full report and show every finding (including
   the P2/P3 ones the comment omitted) and each reviewer's raw output.
7. Demonstrate the second trigger path: paste a GitLab MR URL into the
   "Review a PR/MR" form and submit — no webhook configuration needed for
   this path at all.
8. Open Workers Logs and find the structured `review_started`,
   `reviewer_completed`, `reviewer_skipped`, and `review_posted` events for
   one run, correlated by `runId`, and point out that no diff or finding
   text appears in any of them.
9. Open the AI Gateway dashboard for this demo's gateway and show the
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
- `agents-sdk` (including its Workflows integration, `agents/workflows` —
  read `references/workflows.md` before implementing "Review Orchestration")

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

Two cooperating pieces, deliberately given two different jobs, each doing
only the one it is actually good at:

- **`ReviewRunAgent extends Agent<Env, ReviewRunState>`** (Agents SDK, plain
  `Agent`, not `AIChatAgent` — there is no open-ended conversation here)
  owns the **live connection**: it is the addressable entity a client's
  WebSocket connects to for a run's lifetime, and the only place `state` and
  `broadcast()` are called from. Per the Agents SDK's own guidance table for
  choosing between an Agent alone and an Agent-plus-Workflow ("long-running
  tasks (>30s): Agent + Workflow"), a four-reviewer review run comfortably
  clears that bar.
- **`ReviewPipelineWorkflow extends AgentWorkflow<ReviewRunAgent,
  ReviewTrigger>`** (`agents/workflows`) owns the **pipeline**: the actual
  fetch-diff → review → merge → post-comment sequence, expressed as durable,
  independently retried Workflow steps. This is where "deterministic,
  repeatable flows are good within an agentic architecture" is a design
  decision with a concrete payoff, not a slogan: a transient failure in one
  step (a network blip calling GitHub, a momentary AI Gateway error) retries
  *only that step*, with the Workflow engine's own configurable backoff,
  while every step that already completed — including an already-paid-for
  model call — is never redone.

Both are addressed by the same `runId`, a `crypto.randomUUID()` minted the
moment a trigger is accepted: `getAgentByName(env.REVIEW_RUN, runId)` for
the Agent, and `this.runWorkflow("ReviewPipelineWorkflow", payload)` (called
from inside the Agent, per the Agents SDK's own `AgentWorkflow` integration)
for the Workflow it owns.

```ts
interface ReviewRunState {
  runId: string;
  workflowInstanceId: string;
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

A `@callable() start(payload: ReviewTrigger)` RPC on `ReviewRunAgent` (called
once, immediately after the D1 `review_runs` row is inserted) does the
minimum to answer quickly — per the Agents SDK's own webhook guidance to
"respond quickly" — `setState()`s every reviewer to `queued` (skipping
`accessibility` up front if no changed file qualifies, from the changed-file
list the trigger payload already carries), starts
`const instance = await this.runWorkflow("ReviewPipelineWorkflow", payload)`,
records `instance.id` into `state.workflowInstanceId`, and returns — the
triggering HTTP request (the webhook delivery, or the UI's `POST
/api/reviews`) is answered as soon as the run is accepted, well before the
pipeline finishes.

**`ReviewRunAgent`'s Workflow lifecycle callbacks are the only place `state`
changes after that**, translating the Workflow's own progress reports into
the same `setState()`/`broadcast()` pair demo 6 established (durable state
for a client connecting late; a broadcast event only for a transition a
client already watching needs to animate):

```ts
async onWorkflowProgress(_name: string, _id: string, progress: ReviewerProgress) {
  this.setState({ ...this.state, reviewers: mergeReviewerProgress(this.state.reviewers, progress) });
  this.broadcast({ type: progress.event, role: progress.role, ...progress.detail });
}

async onWorkflowComplete(_name: string, _id: string, result: { commentUrl: string }) {
  this.setState({ ...this.state, status: "completed" });
  this.broadcast({ type: "review_completed", commentUrl: result.commentUrl });
}

async onWorkflowError(_name: string, _id: string, error: Error) {
  await markRunFailed(this.env.DB, this.state.runId, error.message);
  this.setState({ ...this.state, status: "failed" });
  this.broadcast({ type: "review_failed", detail: error.message });
}
```

**`ReviewPipelineWorkflow.run(event, step)`**, the deterministic pipeline
itself:

1. `step.do("fetch-diff", { retries: { limit: 3, delay: "10 seconds",
   backoff: "exponential" } }, ...)` — call the matching `GitProviderClient`.
   A permanent provider response (`404`, `403` — the PR/MR genuinely does
   not exist or is not reachable with this token) throws
   `NonRetryableError` immediately, since retrying cannot help; a transient
   one (`5xx`, a timeout) is left to the step's own retry configuration.
   If every retry is exhausted or a `NonRetryableError` is thrown, `run()`
   never reaches step 2 — the Workflow instance ends `errored`, and
   `ReviewRunAgent.onWorkflowError()` marks the run `failed`. No reviewer
   ever ran, so there is nothing to bill or reconcile.
2. For each active reviewer, in a fixed order (`code-quality`,
   `accessibility`, `architecture`, `security` — cheaper/faster passes
   first, and still one at a time: sequencing the calls, not the Workflow
   engine, is what keeps this legible for a presenter to narrate live, "now
   architecture is running, now security…"):
   - `await this.reportProgress({ role, event: "reviewer_started" })` — a
     **non-durable** ping (fine to lose on a mid-flight interruption; it is
     only a UI liveness cue, never the source of truth).
   - `const result = await step.do(\`review:${role}\`, { retries: { limit:
     2, delay: "15 seconds", backoff: "exponential" }, timeout: "3 minutes"
     }, async () => { ... })` — run the persona (see "Reviewer Personas"),
     then **write its `review_reviewers`/`review_findings` rows inside the
     same step**, as an idempotent upsert keyed on `(run_id, role)`. This
     matters precisely because Workflows guarantees a step's callback runs
     **at least once**, not exactly once: if the D1 write had already
     partially succeeded once before a retry, an ordinary `INSERT` would
     conflict or duplicate rows on the second attempt, while an upsert makes
     re-running the whole step safe. When the bounded one-shot JSON-repair
     retry inside `runReviewer()` itself is exhausted, throw
     `NonRetryableError` rather than letting the step's own retry config
     re-run it — repeating an already-uncooperative model's exact same
     prompt is unlikely to help and would otherwise mean paying for up to
     three near-identical failed calls instead of one.
   - `await step.mergeAgentState({ reviewers: { [role]: { status: result
     ? "done" : "error", findingCount: result?.findings.length ?? 0 } } })`
     — the **durable** counterpart to the ping above: step-checkpointed, so
     it is exactly-once even if the instance is interrupted immediately
     after.
   - `await this.reportProgress({ role, event: "reviewer_completed" })`.
   - Reconcile cost **as Workflow steps, not a hand-rolled schedule.**
     `await step.sleep(\`reconcile-wait:${role}\`, "5 seconds")`, then
     `try { const log = await step.do(\`reconcile-cost:${role}\`, {
     retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
     timeout: "2 minutes" }, () =>
     env.AI.gateway(env.AI_GATEWAY_ID).getLog(result.aiGatewayLogId)); ...
     } catch { /* leave costSource "pending" permanently */ }`. Per
     `docs/DECISIONS.md` #16, an unavailable log **throws**
     `AiGatewayLogNotFound` rather than returning `null` or a `404` — which
     is exactly what makes it fit `step.do()`'s own retry mechanism with no
     custom code: the step's callback throws until the log is ready, the
     Workflow engine backs off and retries it for us, and if all three
     attempts are exhausted the error simply propagates out of `step.do()`
     to our surrounding `try`, where it is treated as a legitimate,
     permanent "stayed pending" outcome — not a failed Workflow instance.
     On success, read `tokens_in`/`tokens_out`/`cost` (the real
     `AiGatewayLog` field names per `docs/DECISIONS.md` #16, not
     `prompt_tokens`/`completion_tokens`), `UPDATE` the `review_reviewers`
     row, `step.mergeAgentState()` the confirmed cost, and
     `this.reportProgress({ role, event: "cost_reconciled" })` so the UI can
     animate the "pending" → confirmed transition the same way demo 6's
     chat badge does. No `reconcile_attempts` bookkeeping is needed in D1 at
     all — the Workflow engine already tracks each step's own attempt count,
     visible in its own step timeline (see "Demo Flow").
3. `step.do("merge-and-post-comment", { retries: { limit: 2, delay: "10
   seconds" } }, async () => { ... })`. **This step's retry must itself be
   idempotent, and deliberately is**: its first line re-reads the
   `review_runs` row and returns immediately if `comment_url` is already
   set, so a retried attempt (network blip after a successful post, for
   example) can never post the same comment twice. Otherwise it calls the
   pure `mergeFindings()` function, builds both report representations (see
   "Report Assembly And Comment Posting"), posts the comment, and updates
   `review_runs` with `status: "completed"`, `comment_url`, the full report,
   and `completed_at` — all inside the one step, for the same "one step,
   one atomic unit of durable work" reason as step 2.
4. `await step.reportComplete({ commentUrl })` — the durable completion
   signal `ReviewRunAgent.onWorkflowComplete()` reacts to.

`ReviewRunAgent` never runs any of this logic itself, holds no in-memory
sequencing, and needs no locking: the Workflow instance is the one and only
place a review's steps are ordered, retried, and checkpointed.

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
- **The reconciliation backoff is a Workflow step's own retry
  configuration, not hand-rolled scheduling code.** `getLog()` throwing
  `AiGatewayLogNotFound` for a not-yet-indexed log (`docs/DECISIONS.md` #16)
  is exactly the shape `step.do()`'s built-in retry mechanism exists for —
  see "Review Orchestration" for the exact step. Compared to demo 6's Agents
  SDK `this.schedule()`-based reconciliation, this needs no bespoke attempt
  counter in D1, and its retry/backoff behavior is inspectable directly in
  the Workflow's own step timeline (see "Demo Flow") instead of only in
  application logs.
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
| `review_runs` | One row per review | `id` (UUID PK), `workflow_instance_id`, `provider`, `repo_full_name`, `pr_number`, `pr_url`, `pr_title`, `pr_author`, `head_sha`, `trigger` (`webhook`\|`manual`), `triggered_by_email` (nullable), `status`, `diff_truncated`, `changed_file_count`, `comment_url` (nullable), `error_detail` (nullable), `created_at`, `completed_at`; `UNIQUE (provider, repo_full_name, pr_number, head_sha)` |
| `review_webhook_deliveries` | Idempotency guard | `id` (`provider:deliveryId`, PK), `run_id` (nullable FK), `received_at` |
| `review_reviewers` | Per-reviewer execution record (upserted by its owning Workflow step — see "Review Orchestration") | `id`, `run_id` FK, `role`, `model`, `status`, `skipped_reason` (nullable), `started_at`, `completed_at`, `error_detail` (nullable), `ai_gateway_log_id` (nullable), `cost_usd` (nullable), `tokens_in`/`tokens_out` (nullable), `cost_source` (`pending`\|`gateway`); `UNIQUE (run_id, role)` — no `reconcile_attempts` column, unlike demo 6's ledger: the Workflow engine already tracks each reconciliation step's own attempt count |
| `review_findings` | Merged findings | `id`, `run_id` FK, `finding_ref`, `priority` (`P0`–`P3`), `severity`, `category`, `file_path` (nullable), `line_number` (nullable), `finding`, `recommendation`, `merged_from` (nullable, comma-separated roles) |

`review_runs.status`/`review_reviewers.status` are the same enums the
`ReviewRunState` (Section "Review Orchestration") mirrors; D1 remains the
source of truth for history and reports, `state` is a live projection for
whichever run is currently open — the same division of responsibility demo
6 draws between its `chat_usage` table and `ChatAgent.state.usage`. The
Workflow instance itself (addressable by `workflow_instance_id`, and shown
in "Demo Flow") is the authoritative record of *how* a run got to that
state — which steps ran, retried, or are still pending — the same way a D1
row is the authoritative record of *what* the outcome was; `README.md`
should link an operator to `wrangler workflows instances describe
review-pipeline-workflow <id>` for the former.

## API And Routing

Only `/api/*` and `/agents/*` are in `run_worker_first`; everything else is
the SPA shell served by the `ASSETS` binding's `single-page-application`
fallback, gated by Access at the edge with no Worker route needed:

- `POST /api/webhooks/github` — public (Access-bypassed; see "Access
  Model"). Verifies the signature, parses the event, and — for a tracked
  action — inserts the `review_runs`/`review_webhook_deliveries` rows and
  calls `start()` on the run's agent, which starts the
  `ReviewPipelineWorkflow` instance that actually runs the review (see
  "Review Orchestration").
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
   in a comment next to the resource. **Workflows need no Terraform
   resource at all**, for the same reason a Durable Object class does not:
   both are declared entirely in `wrangler.jsonc` (a binding plus a
   `class_name`) and deployed by Wrangler, so there is nothing for
   `depends_on` to reference and nothing product-specific for teardown to
   clean up beyond deleting the Worker itself.
3. Commit a single `wrangler.jsonc.tpl` with `{{placeholder}}` markers for
   every Terraform-sourced value (worker name, D1 binding details, the AI
   Gateway id, `cloudflare_team_domain`). Declare `"ai": { "binding": "AI",
   "remote": true }` (Workers AI has no local simulator, exactly as
   `docs/05-AI-CHAT.md` and `docs/DECISIONS.md` #9 already establish for
   this repo), a `"durable_objects"` binding `REVIEW_RUN` →
   `ReviewRunAgent` with a `new_sqlite_classes` migration, and a
   `"workflows"` binding `REVIEW_PIPELINE` → `ReviewPipelineWorkflow`.
   Unlike `ai`, a Workflow binding has no `remote` option at all and is
   **not supported** as a remote binding or under `wrangler dev --remote` —
   Cloudflare's own Workflows local-development story is a full local
   emulation of the real engine, not a proxy to the deployed one, so local
   dev and every integration test exercise real step execution, retries,
   and backoff with no account credentials involved. Also configure `assets`
   with `not_found_handling: single-page-application` and
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
    null }`. Throw a distinguishable `ReviewerJsonInvalidError` when the
    bounded one-shot JSON-repair retry is still exhausted, so its caller
    (step 19) can convert it into a `NonRetryableError` rather than letting
    a Workflow step retry an already-uncooperative model verbatim. Verify
    against the deployed account (per "Reviewer Personas And Structured
    Findings") that both model tiers reliably produce parseable output;
    record the outcome in `docs/DECISIONS.md`.
18. Implement `src/worker/review/merge.ts`: the pure `mergeFindings()`
    function and its severity→priority mapping, unit-tested against every
    dedupe/sort rule in "Reviewer Personas And Structured Findings"
    (including the "no override" rule — confirm a `critical` finding never
    becomes anything but `P0`).
19. Implement `src/worker/workflows/ReviewPipelineWorkflow.ts`: the
    `AgentWorkflow<ReviewRunAgent, ReviewTrigger>` from "Review
    Orchestration" — the `fetch-diff` step (`NonRetryableError` on a
    permanent provider response, default retry on a transient one), the
    per-reviewer loop (`reportProgress()` pings, the `review:<role>` step
    with its idempotent `(run_id, role)` upsert, `mergeAgentState()`, the
    `reconcile-wait:<role>` sleep, and the `reconcile-cost:<role>` step
    whose retry configuration *is* the reconciliation backoff), and the
    `merge-and-post-comment` step (its own idempotent
    already-posted-comment guard). Never accumulate a reviewer's full raw
    output in a variable that outlives its own step's D1 write.
20. Implement `src/worker/agents/ReviewRunAgent.ts`: the much smaller
    `Agent<Env, ReviewRunState>` from "Review Orchestration" — `start()`
    (insert-adjacent `setState()` of every reviewer to `queued`/`skipped`,
    `this.runWorkflow("ReviewPipelineWorkflow", payload)`, record
    `workflowInstanceId`) plus the three Workflow lifecycle callbacks
    (`onWorkflowProgress`, `onWorkflowComplete`, `onWorkflowError`) that are
    now its *only* source of state changes. This class holds no pipeline
    logic, no D1 writes of its own, and no in-memory sequencing — everything
    it used to do sequentially now lives in the Workflow from step 19.
21. Implement `src/worker/review/report.ts`: `buildFullReport()` and
    `buildCommentBody()` from "Report Assembly And Comment Posting",
    sharing the same `MergedFinding[]` input so they cannot drift, and the
    "no findings" honest-empty-report path.
22. Emit `reviewer_started`, `reviewer_completed`, `reviewer_skipped`,
    `reviewer_failed`, and `review_posted` structured logs via
    `cloudflareLogger()`, placed after Access/validation guards, carrying
    role, model, duration, and finding/token counts — never diff text,
    finding text, or a provider token. Do not also log every step retry
    attempt — that history is already visible, per attempt, in the
    Workflow instance's own step timeline (see "Demo Flow"); duplicating it
    into Workers Logs would be redundant, not defense in depth.

### Phase 5 — API routes

23. Implement `src/worker/routes/reviews.ts`
    (`POST /api/reviews`, `GET /api/reviews`, `GET /api/reviews/:id`) and
    `src/worker/routes/me.ts`, mounted from `src/worker/index.ts` (routing
    only), with `src/worker/bindings.ts` as the single
    `AppBindings`/`AppVariables` definition and the toolkit's Hono error
    handler for problem details.
24. Implement the D1 repository layer (`src/worker/data/*.ts`) backing
    "Data Model" — one function per query, never `SELECT *`, thin mappers
    to camelCase domain objects, reused by both the webhook route and the
    manual-trigger route so they share one run-creation code path exactly
    as "Behavior" requires. The `review_reviewers` write is a genuine
    upsert (`INSERT ... ON CONFLICT (run_id, role) DO UPDATE ...`), not a
    plain `INSERT`, since a retried Workflow step calls it more than once
    on purpose (see "Review Orchestration").

### Phase 6 — Browser application

25. Build a focused Vue 3 + Vuetify UI meeting WCAG 2.2 AA on desktop and
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
26. Add `src/client/composables/useReviewRun.ts`, a small, framework-
    agnostic-`AgentClient`-backed Vue composable (following this repo's
    `create-adaptable-composable` conventions and demo 6's
    `useChatAgent` precedent) that connects to `/agents/review-run/:id`,
    exposes the run's `state` as a reactive ref, and surfaces the
    `reviewer_started`/`reviewer_completed`/`cost_reconciled`/
    `review_completed`/`review_failed` broadcast events as a typed stream
    for the badge transition animations. This composable never talks to a
    Workflow directly — from the browser's side, the only observable
    surface is still the Agent's `state`/broadcast, exactly as before;
    "Review Orchestration" is a server-side implementation detail the
    client is not, and should not be, aware of.
27. Manage state in Pinia: a `session` store (identity) and a `reviews`
    store (history list, the currently open run's static detail once
    fetched via REST, merged with `useReviewRun`'s live fields). Keep
    `src/client/main.ts` bootstrap-only with `App.vue`, `views/`,
    `stores/`, `components/`.

### Phase 7 — Tests, deployment, and documentation

28. Add the three Vitest projects from a root `vitest.config.ts`:
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
      **`remoteBindings: false`**, with a comment explaining that only the
      `ai` binding needs this — it would otherwise force a credentialed
      remote proxy session, the same reasoning as `docs/05-AI-CHAT.md`. The
      `workflows` binding needs no equivalent flag: Workflows have full
      local emulation with no remote-binding mode to opt out of at all).
      Drive the Hono app directly (`app.fetch(request, env, ctx)`) with an
      injected fake `Ai` returning scripted fenced-JSON completions and a
      `GitProviderClient` test double, per this repo's established pattern
      for a no-local-simulation binding.
29. Integration tests MUST cover, end to end in real `workerd`: an
    unauthenticated `POST /api/reviews` (blocked) alongside an
    unauthenticated `POST /api/webhooks/github` with a valid signature
    (allowed — proving the bypass application's intent is faithfully
    reproduced in the access-policy array); a rejected webhook with an
    invalid signature/token; a full run from webhook trigger through all
    four reviewers (including one skipped for having no UI files) to a
    posted comment and a `completed` D1 row; the manual-trigger path
    producing the identical D1 shape as the webhook path; and a duplicate
    webhook delivery being a no-op against the idempotency guard. Use
    `introspectWorkflowInstance`/`introspectWorkflow` (`cloudflare:test`) —
    not a hand-rolled fake scheduler — for every Workflow-specific
    scenario, `disableSleeps()`/`disableRetryDelays()` in every one of them
    so a test never actually waits out a real backoff:
    - `mockStepError({ name: "review:code-quality" }, err, 1)` — a
      **transient** failure that succeeds on retry — then assert every
      *other* reviewer's `review_reviewers` row and D1 findings are
      untouched by the retry, the concrete proof of "only the failed step
      re-ran."
    - `mockStepError({ name: "review:security" }, new NonRetryableError(...))`
      (or drive `runReviewer()` to actually exhaust its JSON-repair retry)
      — confirm the run still completes with the other reviewers' findings
      intact and this one recorded `status: "error"`, never aborting the
      whole instance.
    - `mockStepError({ name: "reconcile-cost:code-quality" },
      new AiGatewayLogNotFound(...))` beyond the step's configured retry
      limit — assert the row is left `cost_source: "pending"` permanently
      and the run still reaches `completed`, not `errored`.
    - `mockStepResult({ name: "merge-and-post-comment" }, ...)` on a second,
      deliberately retried attempt of that step — assert
      `GitProviderClient.postComment()` (the test double) was called
      exactly once, proving the idempotent already-posted guard works.
    Configure `@vitest/coverage-istanbul` and `test:coverage`; treat
    uncovered authored source as a gap to close.
30. Provide single-command `npm run deploy` (Terraform init/apply,
    `db:migrate:remote`, `generate-wrangler -cf --terraform infra` +
    `generate:types`, build, `wrangler deploy`) and `npm run teardown`
    (`terraform destroy`), composed from small `package.json` scripts
    chained with `run-s`. A successful teardown leaves no named or
    billable resource behind — the Worker, D1 database, AI Gateway
    resource, and both Access applications. There is no separate teardown
    step for the Workflow: like the Durable Object class, it is deleted
    along with the Worker script that defines it.
31. Write `README.md` (operator/developer guide: prerequisites including
    a GitHub and/or GitLab personal access token and webhook secret,
    environment configuration split between `.env`/`.dev.vars.example`/
    production secrets, local development and its `.dev.vars` exception,
    testing, the exact one-time `wrangler secret put` commands, exact
    deployment and verification steps — including how to point a real
    repository's webhook at the deployed hostname — how to find a run's
    Workflow instance in the dashboard or via `wrangler workflows instances
    describe`, troubleshooting, and exact teardown), `DEMO.md` (the
    presenter script from "Demo Flow", including the rehearsal trick for
    forcing a transient step failure ahead of a live demo — for example a
    feature flag or a temporary Worker var that makes the `fetch-diff` step
    throw once), and `EXPLAIN-DEMO.md` (what this demo teaches about
    consuming third-party webhooks safely, running several independent AI
    passes and merging them deterministically, why `aiGatewayLogId` works
    here when demo 6 had to work around it, the deliberate LLM-only
    "security review" limitation versus real SAST, **why Workflows appear
    here ahead of demo 14 and what specifically pairing deterministic steps
    with an agent's non-deterministic ones buys — retry isolation, no
    re-billing completed work, and an inspectable step timeline — versus
    demo 14's different Workflows lesson**, and a "Further Reading"
    section). Add JSDoc to every authored TypeScript declaration.
32. Verify formatting, linting, type checking, all three Vitest projects,
    the production build, the generated Wrangler configuration, and
    `terraform fmt -check`/`terraform validate` in `infra`. Do not run
    `terraform apply`, deploy, or destroy real resources, and do not
    register a real webhook against a live repository, unless the
    operator explicitly requests it and provides the environment.
