# Agentic Chat — What This Demo Teaches

This demo is the curriculum's introduction to the Agents SDK, built feature by feature rather than layer by layer. The full plan — every user story, design decision, spike, and phase — lives in [`docs/06-AGENTIC-CHAT.md`](../../docs/06-AGENTIC-CHAT.md); this file only covers what **this checkout** (Phase 1, Scaffolding) actually implements. Later phases will extend this file as their own features ship.

## What This Phase Demonstrates

- **A demo built and tagged in independently reviewable phases.** Unlike every earlier demo in this curriculum, `docs/06-AGENTIC-CHAT.md` breaks this build into one user story per phase, each tagged in git (`agentic-chat/phase-01-scaffolding`, `agentic-chat/phase-02-core-chat`, …) so any two phases can be diffed directly. This phase's job is to prove the baseline — deployable, Access-gated, tested, and empty of the actual chat feature — so every later phase's diff is pure feature work, not scaffolding noise.
- **Spikes before features.** Six spikes (`spikes/00`–`spikes/05`) answered the platform's riskiest open questions — whether `AIChatAgent` composes with a hand-built Vue client, which Workers AI models survive a dynamic route's model node, how Dynamic Workers' `globalOutbound` gateway actually wires up, whether the Agents SDK's skills mechanism is `AIChatAgent`-agnostic, the real speech-to-text input contract, and how to correlate a dynamic-route call back to its AI Gateway log row — *before* any feature code assumed an answer. This phase's Terraform and Wrangler configuration is written against those confirmed findings, not assumptions; see each spike's own `REPORT.md`.
- **Cloudflare Access pinning `audience`, and why that is not always the default.** Every demo in this repo requires the whole hostname to sit behind Cloudflare Access, but not every demo pins the Access application's `audience` claim. This one does, because every chat this demo will hold is sensitive, billable AI conversation history — accepting a token minted for *any other* Access application in the same Zero Trust team (every application in a team shares the same JWKS) is not an acceptable trade-off here, unlike `demos/todo-app`'s deliberately simpler posture. Because `cloudflareAccess()` reads its `audience` option once at Worker module-load time — before any request-scoped `env` binding exists — the real Access application's AUD tag cannot be threaded in as an ordinary `wrangler.jsonc` var the way `CLOUDFLARE_TEAM_DOMAIN` is. It is threaded in as a Vite build-time define instead (`VITE_ACCESS_AUDIENCE`, read from the `access_audience` Terraform output only at `npm run deploy` time — see `package.json`'s `deploy:worker:publish` script and `src/worker/middleware/access.ts`).
- **A D1-flagged application role, kept separate from Cloudflare Access.** "Administrator" is a `users.is_admin` column, not a second Access application or policy — Access has no concept of this demo's business role, and role-based authorization is correctly an application-layer concern (AGENTS.md, "Admin Authorization Is An Application Concern"). `UserRepository.ensureUser()` is the one place this is decided: every verified sign-in idempotently upserts a `users` row, and the identity matching the Worker's `ADMIN_EMAIL` variable is always re-forced to `is_admin = 1`, regardless of prior D1 state — so the role survives a redeploy or a partial teardown that left a stale row behind, without needing a separate bootstrap script or manual dashboard step.
- **Infrastructure provisioned ahead of the code that uses it.** This phase's Terraform already provisions the full AI Gateway and both of its dynamic routes (`agentic-chat-basic`, `agentic-chat-reasoning`), confirmed fully Terraform-manageable by Spike B — even though no Worker route calls them yet. Provisioning them now means a later phase's diff is application code only, not a second infrastructure change.

## How It Works

### Data model

`migrations/0001_create_users_and_chats.sql` defines two tables:

```sql
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT,
  route TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX chats_owner_email_idx ON chats (owner_email);
```

`chats` is created now, indexed on `owner_email`, even though no route reads or writes it yet — Phase 2 (US-1, core agentic chat) is what actually instances a `ChatAgent` Durable Object per row and enforces ownership. `title`/`route` stay nullable until Phase 3's auto-titling and Phase 4's route selection exist.

### Routing and the Access model

Every path on this hostname requires authentication — there is no public route (`src/access-policies.ts`), matching `demos/todo-app`/`demos/chat`'s whole-hostname pattern rather than `demos/url-shortener`'s mixed public/admin one. `src/worker/index.ts` applies `accessMiddleware` (`src/worker/middleware/access.ts`) to every `/api/*` route before mounting `/api/me`; page routes are served directly by the `ASSETS` binding's `single-page-application` fallback, with Access enforcing authentication at the edge before the request ever reaches the Worker or that fallback.

### The `/api/me` route is also the admin-bootstrap path

`src/worker/routes/me.ts` is deliberately the *only* place `UserRepository.ensureUser()` (`src/worker/users/repository.ts`) runs. There is no separate registration endpoint and no one-time bootstrap script: every call to `GET /api/me` — which the client always makes once on load (`src/client/stores/session.ts`) — upserts the verified identity's D1 row and idempotently corrects its `is_admin` flag to match whether that identity is the configured `ADMIN_EMAIL`. The repository issues two structurally different SQL statements for this, not one parameterized branch, so the intent is legible directly from the SQL text: an ordinary identity's statement only ever inserts a fresh row (`ON CONFLICT (email) DO NOTHING`, never touching an existing row's flag — preserving a manual promotion a future admin console might make to someone else), while the administrator identity's statement always re-applies `is_admin = 1` (`ON CONFLICT (email) DO UPDATE SET is_admin = 1`) no matter what was there before.

### Observability

`cloudflareLogger()` provides request-scoped structured logging on every request. Terraform enables Workers Logs at 100% sampling and traces at 10% sampling on the Worker resource — the same defaults every demo in this repo uses.

## Further Reading

- `docs/06-AGENTIC-CHAT.md` — the full feature-by-feature implementation plan this demo follows.
- `spikes/00-aichatagent-basics/REPORT.md` through `spikes/05-workers-ai-speech-to-text/REPORT.md` — the platform findings this and every later phase are built against.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [D1](https://developers.cloudflare.com/d1/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [AI Gateway dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [Agents SDK](https://developers.cloudflare.com/agents/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [Hono](https://hono.dev/docs/getting-started/cloudflare-workers)
