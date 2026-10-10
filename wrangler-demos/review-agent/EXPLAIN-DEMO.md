# PR Review Agent — What This Demo Teaches

## What This Demonstrates

- **Consuming a signed, unauthenticated-by-Access inbound webhook safely.** Every earlier demo in this repository puts every non-public route behind a verified Cloudflare Access identity. A third-party SaaS platform (GitHub, GitLab) cannot present one at all, so `POST /api/webhooks/github`/`gitlab` are carved out of Access entirely and instead verify each provider's own signing mechanism inside the handler — GitHub's HMAC-SHA-256 `X-Hub-Signature-256`, GitLab's shared `X-Gitlab-Token` — with a timing-safe comparison, never a plain `===`.
- **Running several independent AI passes over the same input and merging their structured output deterministically.** Four reviewer personas (architecture, security, code quality, accessibility) each run their own Workers AI call against the same diff, in their own Cloudflare Workflow step. Their structured findings are merged into one report by a pure TypeScript function (`src/worker/review/merge.ts`) — not a fifth model call — so the merge step is deterministic, unit-testable, and free.
- **Why Workflows appear here ahead of their usual curriculum position.** Workers AI, AI Gateway, Durable Objects, and the Agents SDK's `state`/`broadcast()` mechanism were all already introduced by earlier demos. This is the first demo to wrap an agent's inherently non-deterministic steps (an LLM call, with tool use, whose output shape and retry behavior are never fully predictable) inside a Cloudflare Workflow's deterministic, checkpointed steps — see "Why Workflows, Here, Ahead Of Schedule" below.
- **Why `aiGatewayLogId` works here when an earlier demo had to build a workaround for it.** See "Cost Reconciliation: A Literal Model Id, Not A Dynamic Route" below.
- **A deliberate, load-bearing limitation: LLM-only "security review," not real SAST.** See "The Security Reviewer Is Not A Security Scanner" below.
- **The inverted Access application layout.** See "Two Access Applications, Inverted Roles" below.

## How It Works

### Two cooperating pieces: `ReviewRunAgent` and `ReviewPipelineWorkflow`

```mermaid
flowchart LR
    GH[GitHub/GitLab webhook] -->|verified signature| Webhook[webhooks.ts]
    UI[Browser: paste a URL] -->|Access identity| Reviews[reviews.ts]
    Webhook --> StartRun[startRun.ts]
    Reviews --> StartRun
    StartRun -->|getAgentByName + start| Agent[ReviewRunAgent]
    Agent -->|runWorkflow| Workflow[ReviewPipelineWorkflow]
    Workflow -->|fetch-diff| Provider[GitHubProviderClient / GitLabProviderClient]
    Workflow -->|review:role, one step per reviewer| AI[Workers AI via AI Gateway]
    Workflow -->|reconcile-cost:role| Gateway[env.AI.gateway(id).getLog()]
    Workflow -->|merge-and-post-comment| Provider
    Workflow -.->|reportProgress / reportComplete| Agent
    Agent -.->|setState + broadcast| Client[Run detail page]
```

`ReviewRunAgent` (`src/worker/agents/ReviewRunAgent.ts`) is a plain Agents SDK `Agent`, not an `AIChatAgent` — there is no open-ended conversation here. It owns exactly one thing: the live WebSocket connection a client's run-detail page holds open, and the `state`/`broadcast()` calls that connection observes. Its `start()` method does the minimum to answer quickly (per the Agents SDK's own webhook guidance): mark every reviewer `queued`, start the Workflow, record its instance id, and return — the triggering HTTP request is answered well before the pipeline finishes.

`ReviewPipelineWorkflow` (`src/worker/workflows/ReviewPipelineWorkflow.ts`) owns everything else: the actual `fetch-diff` → review → merge → post-comment sequence, expressed as durable, independently retried Workflow steps. `ReviewRunAgent` never runs any of this logic itself and holds no in-memory sequencing — three lifecycle callbacks (`onWorkflowProgress`, `onWorkflowComplete`, `onWorkflowError`) are its only source of state changes after `start()` returns.

### Why Workflows, Here, Ahead Of Schedule

This repository's curriculum principle is "introduce at most one major platform concept per demo" and "do not reach for a Workflow when a request or Queue consumer is sufficient." In the narrow sense of "the pipeline would still run," a Durable Object's own in-memory sequencing genuinely would be sufficient here too. Workflows are pulled forward anyway because the lesson this demo exists to teach is a different emphasis than a later demo's own Workflows lesson (a long-running pipeline that waits on human approval): pairing an agent's non-deterministic steps with deterministic, checkpointed, automatically retried orchestration.

The payoff is concrete, not a slogan. A transient failure in one reviewer's call — a network blip calling GitHub, a momentary AI Gateway error — retries *only that step*, with the Workflow engine's own configurable backoff, while every step that already completed (including an already-paid-for model call) is never redone. `merge-and-post-comment`'s own idempotent guard (re-reading `review_runs.comment_url` before posting) is what makes even that last step safe to retry: a network blip after a successful post can never double-post, because the guard sees the URL a prior attempt already recorded and returns immediately. The Workflow instance's own step timeline — one step per reviewer, one per cost reconciliation, each with its own status and retry count — is directly inspectable in the Cloudflare dashboard, giving a presenter (or an on-call engineer) a granular view no amount of application logging alone provides.

### Cost Reconciliation: A Literal Model Id, Not A Dynamic Route

An earlier chat demo needed a correlation-UUID workaround against AI Gateway's logs-list REST API, because every one of its calls used a *dynamic route* name as the model argument — confirmed to null out `env.AI.aiGatewayLogId` unconditionally (`docs/DECISIONS.md` #13). This demo never uses a dynamic route: every reviewer call passes a **literal model id** (`src/models.ts`'s two model tiers), so `aiGatewayLogId` populates normally. Reconciliation is therefore one binding call, `env.AI.gateway(env.AI_GATEWAY_ID).getLog(logId)`, with no REST call, no extra Wrangler secret for a Cloudflare API token, and no correlation metadata needed at all.

`getLog()`'s "not yet indexed" signal is a **thrown** error (`docs/DECISIONS.md` #16), not a `null`/`404` — which is exactly the shape `step.do()`'s own retry mechanism exists for. The `reconcile-cost:<role>` step's callback throws until the log is ready; the Workflow engine backs off and retries it with no custom scheduling code, and if every attempt is exhausted, the error simply propagates out of `step.do()` to a surrounding `try`/`catch`, where it is treated as a legitimate, permanent "stayed pending" outcome — `review_reviewers.cost_source` simply never changes from `'pending'`, and the run still completes normally.

### The Security Reviewer Is Not A Security Scanner

The real `security-reviewer` OpenCode subagent this persona is condensed from refuses to run at all unless `semgrep`/`codeql` are on `PATH` — tools a Workers isolate cannot exec. Every reviewer pass here, security included, is LLM analysis of the diff (plus whatever the shared `getFileContent` tool pulls in for extra context), never real static analysis. This is a deliberate, load-bearing limitation, not an oversight: a production version of this idea would run that stage in a container or CI job instead — a natural pointer to the Sandbox SDK/Containers demo elsewhere in this curriculum, without this demo needing to implement it.

The merge/dedupe step is similarly narrowed on purpose. The real `review-orchestrator` uses judgment — reading every reviewer's raw Markdown — to decide when two findings share a root cause. This demo's `mergeFindings()` only merges findings that share an exact `(filePath, lineNumber)` pair across reviewers, and never overrides the severity→priority mapping a critical finding always keeps. Simpler, deterministic, unit-testable, and free — a smaller, less human-like version of the same lesson, not an equivalent one.

### Two Access Applications, Inverted Roles

Every other demo in this repository's canonical shape is "public bypass by default, a narrower `allow` application for protected paths." This demo needs the opposite emphasis: triggering a review is billable AI compute, so the whole hostname defaults to requiring *any* authenticated identity, and only the two webhook paths — which GitHub/GitLab call with no Access identity at all — carve out an exception with a `bypass` policy. Access still routes each request to the most specific matching application; the default and the exception are simply swapped from the canonical example.

### Provider Integration

`src/worker/providers/` defines one shared `GitProviderClient` interface and one module per provider (`github.ts`, `gitlab.ts`), mirroring the "one small interface, one file per implementation" shape an earlier chat demo uses for model-shape heterogeneity, applied here to provider-API heterogeneity instead. Every method takes an injected `fetch`, so both providers' own unit tests (`github.test.ts`/`gitlab.test.ts`) — and this demo's own integration tests — substitute a scripted `fetch` and never make a real network call. A diff is capped at 60,000 characters and 40 files (generated/lockfile paths skipped first), and every cap that actually truncates content is recorded on the run so the UI and the posted comment can say so honestly.

### Reviewer Output Contract

Every persona's system prompt ends with an instruction to reply with prose first, then exactly one fenced `json` code block containing a validated findings array (`src/worker/review/schema.ts`'s `zod` schema). This convention — fenced JSON in an otherwise ordinary chat completion, not provider-native structured output — is deliberate: Workers AI models do not share one structured-output capability, confirmed by an earlier demo, so this demo does not assume one either. A parse/validation failure gets exactly one corrective retry ("Your last response's JSON was invalid... Return ONLY the corrected JSON array") before `runReviewer()` gives up — bounded, so one uncooperative model cannot loop, and `ReviewPipelineWorkflow` converts that exhaustion into a `NonRetryableError` rather than letting the step retry an already-uncooperative model's exact same prompt a third and fourth time.

### Testing This Demo's Own Coverage Gap

`@cloudflare/vitest-pool-workers` v0.19.x has no mechanism to forward istanbul's coverage counters out of the `workerd` isolate a test file runs in, and separately, this repository's own `tests/integration/` project needed the Agents SDK's `agents/vite` plugin registered a *second* time (the root `vite.config.ts`'s own registration only covers `vite dev`/`vite build`) before any test file could even *import* `src/worker/index.ts` at all, since `ReviewRunAgent`'s `@callable()` decorator otherwise throws a bare syntax error the moment Vite tries to parse it. Fixing that import path — plus discovering that a Durable Object/Workflow defined in the same Worker script shares the exact same `env` object reference a test file's own top-level code sees, letting a test patch `env.AI.run()` directly and have `ReviewPipelineWorkflow`'s own `this.env.AI` calls observe it — is what makes this demo's full end-to-end integration tests possible with no live Workers AI account at all. See `docs/DECISIONS.md` for the full write-up.

## Further Reading

- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Agents SDK: run workflows](https://developers.cloudflare.com/agents/api-reference/run-workflows/)
- [Agents SDK overview](https://developers.cloudflare.com/agents/)
- [Workers AI](https://developers.cloudflare.com/workers-ai/)
- [AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [AI Gateway logs](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [GitHub webhooks: pull_request event](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request)
- [GitLab webhooks: merge request events](https://docs.gitlab.com/user/project/integrations/webhook_events/#merge-request-events)
