# Agentic Chat

An authenticated enterprise AI chat agent based on Cloudflare Workers, D1, Cloudflare Access, Durable Objects, the Agents SDK, Workers AI, AI Gateway, and Dynamic Workers.

> This demo ships in phases (see `docs/06-AGENTIC-CHAT.md`), each tagged in git so any two can be diffed. This checkout implements **Phase 1 (Scaffolding)** through **Phase 11 (Personal And Enterprise Skills, US-10)**: a signed-in user can hold a real, streamed, multi-turn conversation with a Durable Object-backed `ChatAgent`, persisted across reloads, manage more than one chat from a sidebar -- creating, switching between, and deleting chats, each auto-titled after its first exchange -- choose between a "Basic" and a "Reasoning" mode per chat, each backed by a governed AI Gateway dynamic route rather than a client-visible model id, dictate a prompt via microphone, transcribed by Workers AI into editable composer text, see each chat's running cost/token totals, immediately labeled **Estimated** and later upgraded in place to **AI Gateway**-confirmed figures once AI Gateway's own logged cost/tokens for that turn are found, and -- for the identity matching `ADMIN_EMAIL` -- open an Admin Console ranking every user by total cost, editing any user's business/geo segment, and viewing cost broken down by business and by geo. Each governed route also branches, entirely platform-side, on the caller's business segment: AI Gateway's own conditional/rate-limit elements steer a "Field" segment to one model and every other segment to a stronger one (rate-gated per segment), with a gateway-level spend limit partitioned the same way -- all with zero client-visible difference in what the browser sends. The agent can call a `writeMarkdown` tool -- asking it to produce a document saves a real file to R2, attached to the chat, and renders as a downloadable attachment chip in the transcript, visible only to that chat's owner -- and a `getUrl` tool that fetches an allow-listed destination through a Dynamic Worker's egress-controlled `globalOutbound` gateway, refusing (and explaining the refusal) for anything else. Any signed-in user can also add their own personal skill (a Markdown instruction bundle, uploaded or fetched from a URL) from the **Skills** page, visible only to their own chats, and an administrator can add an enterprise skill from the Admin Console, visible to everyone; the agent activates a matching skill automatically, shown as a chip in the transcript. A later phase adds exports.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare account with a zone that can host `<DEMO_NAME>.<DEMO_DOMAIN>` (default `agentic-chat.cfapps.uk`) and no conflicting CNAME on that hostname.
- A Workers Paid plan or above -- Dynamic Workers (the `getUrl` tool's `worker_loaders` binding, Phase 10) currently requires it (developers.cloudflare.com/dynamic-workers/pricing/). This binding needs no Terraform resource and no extra API token permission, so it does not otherwise appear below.
- A Cloudflare Zero Trust team with at least one enabled identity provider — any authenticated user from that provider can sign in.
- A Cloudflare API token scoped to the target account and zone with:
  - Entire Account > Developer Platform > Workers Scripts: Edit
  - Entire Account > Developer Platform > D1: Edit
  - Entire Account > Developer Platform > Workers AI: Edit (also required for local development — see Troubleshooting)
  - Entire Account > Developer Platform > AI Gateway: Edit (also covers the one runtime REST call the cost ledger makes directly to read back a turn's logged cost -- see Provisioned Resources)
  - Entire Account > Developer Platform > Workers R2 Storage: Edit (the bucket `ChatAgent`'s `writeMarkdown` tool stores files in, and the `empty-r2-bucket` preteardown step -- Phase 9)
  - Entire Account > Cloudflare One / Zero Trust > Access: Edit
  - Entire Account > Cloudflare One / Zero Trust > Access: Identity Providers: Read
  - `<your-domain>` > DNS & Zones > DNS: Write

## Environment Configuration

```sh
cd demos/agentic-ai-chat
cp .env.example .env
```

Set every value in `.env`:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with the permissions listed above. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker, D1 database, AI Gateway, and Access application. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `DEMO_DOMAIN`. |
| `DEMO_DOMAIN` | Zone hostname the demo is deployed under, e.g. `cfapps.uk`. |
| `DEMO_NAME` | Worker name, AI Gateway id, and hostname label, e.g. `agentic-chat` for `agentic-chat.cfapps.uk`. |
| `CLOUDFLARE_TEAM_DOMAIN` | Access team domain without `https://`, e.g. `example.cloudflareaccess.com`. |
| `ADMIN_EMAIL` | Identity idempotently promoted to this demo's D1-flagged administrator role on every sign-in. |

Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated binding types (`worker-configuration.d.ts`).

`CLOUDFLARE_API_TOKEN` is also pushed as the deployed Worker's own `CLOUDFLARE_API_TOKEN` secret (`npm run deploy:worker:secrets`, part of `npm run deploy`) -- the cost ledger's `reconcileUsage()` step needs it at runtime to read back a turn's logged cost via the one REST call this demo makes outside a binding (`docs/06-AGENTIC-CHAT.md` Section 6.6). `CLOUDFLARE_ACCOUNT_ID` is threaded to the Worker as an ordinary `vars` entry (Terraform output `cloudflare_account_id`) for the same call.

## Local Development

```sh
npm install
npm start
```

`npm start` generates `wrangler.jsonc` from `wrangler.jsonc.tpl` and the committed local placeholder values in `infra/local-outputs.json`, generates binding types, applies the D1 migration to the local SQLite database (`db:migrate:local`), builds, and starts Vite. No Terraform state or cloud resources are required for the Access, D1, or SPA-shell behavior. Open the printed local address and sign in using the local Access dev-login form, which offers `admin@example.com` (this demo's local administrator) and `alice@example.com` (an ordinary identity). An always-visible **Sign out** control uses `/cdn-cgi/access/logout`, useful for recovering from having signed in as the wrong identity. Local D1 data lives under `.wrangler/` and can be deleted between sessions.

The `AI` binding has no local simulator (`docs/05-AI-CHAT.md`, "Workers AI Has No Local Simulation"): `vite dev` always reaches the real account for it, using the local placeholder AI Gateway id `"default"` (`infra/local-outputs.json`), which auto-provisions on first use. Signing in and sending a message locally makes a real, billable Workers AI call.

## Testing

```sh
npm run check          # format, lint, type check, Terraform fmt/validate
npm run test:unit      # Worker and client unit projects
npm run test:integration
npm run test:coverage
npm run build
```

`tests/integration/dynamic-routes.test.ts` (Phase 4) substitutes a fake `env.AI` binding, like every other integration test in this checkout, and asserts on the exact `dynamic/<route-name>` model id string `ChatAgent` calls -- it never makes a real call against AI Gateway, so it passes identically against the local placeholder route names (`infra/local-outputs.json`) or a real, deployed gateway.

`tests/integration/transcribe.test.ts` (Phase 5) substitutes a fake `env.AI` binding the same way, so `POST /api/transcribe` is exercised end to end with no real, billable Workers AI call. `src/client/composables/useVoiceDictation.test.ts` stubs the browser's `MediaRecorder`/`navigator.mediaDevices.getUserMedia` with deterministic doubles -- no real microphone or audio hardware is needed to run `npm test` in CI or on a fresh checkout.

`tests/integration/usage.test.ts` (Phase 6) substitutes the global `fetch` (`withFakeFetch`) to simulate AI Gateway's logs-list REST endpoint, so every branch of `ChatAgent.reconcileUsage()` -- a matching log found, none found yet, the bounded retry budget exhausted, a REST failure, and a row that has disappeared -- is exercised with no real network call, by invoking the real method directly via `runInDurableObject()` rather than waiting on its own real 10s/+15s schedule delays. A local `vite dev`/`vitest` run has no real `CLOUDFLARE_API_TOKEN` secret configured (see Troubleshooting), so a real local turn's reconciliation permanently stays `estimated` -- a legitimate, visible outcome this demo's own design already expects, not a bug.

`tests/integration/admin.test.ts` (Phase 7) drives real turns the same way `usage.test.ts` does to produce real `chat_usage` rows for several identities, then exercises `requireAdmin()`'s enforcement (unauthenticated `401`, non-administrator `403`) and every `/api/admin/*` route -- the ranked user-cost table, business/geo metadata mutation (including validation and a nonexistent-email `404`), and both segment reports, checking a report's total against the sum of its constituent users' own figures.

`tests/integration/metadata-routing.test.ts` (Phase 8) substitutes a fake `env.AI` binding, like `dynamic-routes.test.ts`, and asserts on the exact `gateway.metadata` object `ChatAgent` calls it with for two identities with different admin-assigned business segments -- proving the correct, D1-sourced value reaches AI Gateway for the correct caller, re-read fresh on every request, never from anything the client's own message could set. It does not re-verify that AI Gateway's own conditional node actually resolves two different segments to two different models -- that mechanism was already confirmed live by Spike B (`spikes/01-ai-gateway-dynamic-routing/REPORT.md`); observing it against a real, deployed gateway is a manual step in Post-Deploy Verification instead.

`tests/integration/files.test.ts` (Phase 9) drives the `writeMarkdown` tool end to end against a fake `env.AI` binding scripted to emit a real Workers AI native-format tool call (`fixtures.ts`'s `createSequencedFakeAi()`/`writeMarkdownToolCallPayloads()`) -- not a mocked tool result -- so the same code path a real model's tool call takes (`workers-ai-provider`'s own streaming decoder) is what the test exercises. It asserts the resulting R2 object and `chat_files` row, that only the chat's owner can download the file (`404` for a different identity or a foreign chat id, indistinguishable from a nonexistent one), that a `chat_files` row surviving its own R2 object's deletion still reports `404` rather than a broken download, and that invalid tool input (empty content) fails the tool call without writing anything while still letting the turn complete normally.

`tests/integration/egress-gateway.test.ts` (Phase 10) unit-tests `EgressGateway` directly with an injected fake `fetch` (`networkFetch.impl`), asserting the allow/block decision with zero real network traffic -- colocated under `tests/integration/` rather than beside its source file because `EgressGateway` imports `cloudflare:workers`, which the plain-Node `worker` Vitest project cannot resolve (the same reason `ChatAgent` itself has no colocated unit test). `tests/integration/get-url.test.ts` drives the `getUrl` tool end to end through a real `ChatAgent` Durable Object, a real `worker_loaders`-backed Dynamic Worker, and the real `EgressGateway` -- unlike every other binding this demo's tests fake, `worker_loaders` has no account-level proxy step to fake (Spike C's own finding), so the allow-listed case makes a genuine outbound HTTPS request to a real, stable Cloudflare-owned hostname (`src/worker/egress/allowlist.ts`) from inside the test itself; the blocked case never reaches the network at all. This is this demo's second real-network-touching test, after `dynamic-routes.test.ts` deliberately chose *not* to touch the real account -- the difference is that `worker_loaders`/`EgressGateway` need no deployed, account-specific resource to exist first, so this test's outcome does not depend on whether the demo has ever been deployed, unlike a real AI Gateway call would.

`tests/integration/skills.test.ts` (Phase 11) exercises the personal/enterprise `/api/skills`/`/api/admin/skills` CRUD routes end to end (ownership isolation, a duplicate-name rejection within one scope, R2 cleanup on delete), calls `buildSkillRegistry()` directly against the real `FILES` R2 binding to prove its catalog composition (enterprise ∪ the caller's own personal skills, never another user's) -- the same real-R2 requirement that keeps `agents/skills`'s `r2()` source out of the plain-Node `worker` Vitest project, mirroring `files.test.ts`'s own R2-write testing -- and drives one real turn through a fake model scripted to call `activate_skill`, asserting the tool's result carries the *genuine* R2-stored skill content, not a stubbed value.

## Deployment

```sh
cd demos/agentic-ai-chat
npm run deploy
```

`npm run deploy` runs `deploy:infra` (Terraform `init` then `apply -auto-approve`, reading configuration from `.env`) followed by `deploy:worker`. Before building, the `predeploy:worker` hook regenerates `wrangler.jsonc` from the live Terraform outputs (`generate-wrangler -cf --terraform infra`) and regenerates binding types (`generate-wrangler-types`). `deploy:worker` then applies D1 migrations to the remote database (`db:migrate:remote`), reads the Access application's real Audience tag from the `access_audience` Terraform output into the `VITE_ACCESS_AUDIENCE` build-time define, and runs `vite build && wrangler deploy`.

### Post-Deploy Verification

1. Visit `https://<DEMO_NAME>.<DEMO_DOMAIN>` (default `https://agentic-chat.cfapps.uk`) and authenticate through the configured identity provider.
2. Confirm the header shows your signed-in email and an **Administrator** badge only if you signed in as `ADMIN_EMAIL`.
3. Click **+ New Chat**. Confirm the "Mode" dropdown shows **Basic**, is enabled, and offers exactly "Basic"/"Reasoning".
4. Send a message in the composer and confirm a streamed response appears; confirm the "Mode" dropdown is now disabled.
5. Confirm the sidebar entry for this chat acquires a short generated title shortly after the response finishes.
6. Click **+ New Chat** again, switch its "Mode" to **Reasoning** before sending anything, then send a message and confirm a streamed response still appears.
7. Click back to the first chat in the sidebar and confirm its own history and "Basic" mode still load correctly.
8. Reload the page and confirm the same chat list and conversations reappear (loaded from D1 and the `ChatAgent` Durable Object's own storage, not browser memory).
9. Delete a chat from the sidebar and confirm it disappears from the list and the view falls back to a remaining chat (or the empty state if none remain).
10. Click the microphone control on the composer, allow microphone access when prompted, dictate a short question, then click it again to stop. Confirm the transcribed text appears in the composer -- not submitted automatically -- and can be edited before sending.
11. Confirm the chat header shows a cost/token readout immediately after step 4's response, labeled **Estimated**; within roughly 10-40 seconds (reload the page if needed to observe the push), confirm it flips to **AI Gateway** with a "1 of 1 turn confirmed by AI Gateway" ratio, and that the sidebar entry for the same chat shows a matching figure.
12. Confirm the header shows an **Admin console** link (you should still be signed in as `ADMIN_EMAIL` from step 1). Click it.
13. Confirm the ranked "Users by cost" table shows your own identity with the cost from step 11, and that a non-administrator identity you have signed in as previously (if any) also appears, ranked below if its cost is lower.
14. In your own row, change the **Business** dropdown to any value other than "Unspecified" and confirm the row updates without a page reload; do the same for **Geo**.
15. Confirm the "Cost by business" and "Cost by geo" sections now show a row for the segment you just picked, with a cost figure matching your own row in the users table.
16. Sign out using the visible **Sign out** control, sign back in as a non-administrator identity, and confirm no **Admin console** link appears in the header.
17. Attempt to open `https://<DEMO_NAME>.<DEMO_DOMAIN>/admin` directly as that non-administrator identity. Confirm the page loads (Cloudflare Access itself does not block it -- there is only one Access application on this hostname) but shows an error message instead of any table, since `requireAdmin()` rejects every `/api/admin/*` request with `403`.
18. Sign back in as `ADMIN_EMAIL`.
19. In the Cloudflare dashboard under **D1** > `<DEMO_NAME>-db` > Console, run `SELECT email, is_admin, business, geo, created_at FROM users;` and confirm your identity was upserted with the expected `is_admin` value and step 14's business/geo selections; run `SELECT chat_id, cost_source, cost_usd, gateway_log_id FROM chat_usage;` and confirm step 11's turn shows `cost_source = 'gateway'` with a non-null `gateway_log_id`.
20. Under **Workers & Pages** > `<DEMO_NAME>` > **Logs**, confirm requests are being logged, including `chat_created`, `chat_connected`, `chat_route_changed`, `chat_deleted`, `transcription_completed`, and `admin_user_metadata_updated` entries.
21. Under **AI Gateway** > `<DEMO_NAME>`, open the **Basic** and **Reasoning** dynamic routes and confirm each shows requests from the corresponding chat above, resolved to their own configured model; open the gateway's overall request log and confirm a `@cf/openai/whisper-large-v3-turbo` entry from step 10's dictation, and that the logged cost for step 4's turn matches step 19's D1 row.
22. In the Admin Console, set your own identity's **Business** to **Leadership**, then send another message in an existing "Basic" mode chat. Under **AI Gateway** > `<DEMO_NAME>` > the **Basic** route's request log, confirm this newest request resolved to a different, stronger model than step 21's entry -- the same route, the same "Basic" mode, a different model purely from your business segment. Change your own **Business** to **Field**, send one more message in the **same** chat, and confirm the log's newest entry resolves back to the original, cheaper model.
23. Open the **Basic** route's own configuration (not its log) and confirm it shows a `business-check` conditional element, a rate-limit element on its "false" branch, and two model elements. Open the gateway's own settings and confirm a **Spend limits** rule exists, partitioned by the `business` metadata dimension.
24. In any chat, ask the agent to produce a short document (for example "Write me a three-item packing list as a Markdown file"). Confirm the reply includes an attachment chip below the assistant's text, showing a generated `.md` filename.
25. Click the attachment chip and confirm it downloads a Markdown file whose content matches what the assistant produced.
26. Sign out and sign back in as the non-administrator identity from step 16. Confirm this identity cannot open the file from step 25 by constructing the same `/api/chats/<chatId>/files/<fileId>` URL directly (append `?` nothing needed -- just reuse the path) -- expect `404`, not the file's content.
27. Under **R2** > `<DEMO_NAME>-files`, confirm one object exists under a `chats/<chatId>/files/` prefix matching step 24's chat.
28. In any chat, ask the agent to fetch an allow-listed page (for example "Please fetch https://developers.cloudflare.com/workers/ and summarize it in one sentence"). Confirm the reply describes real page content, not an error.
29. In the same chat, ask the agent to fetch a destination not on the allow-list (for example "Please fetch https://cloudflare.com/"). Confirm the reply explains the destination is not allowed, rather than the turn failing or hanging.
30. Under **Workers & Pages** > `<DEMO_NAME>` > **Logs**, confirm an `egress_gateway_decision` entry for each of steps 28/29, with `"allowed":true`/`"allowed":false` respectively and the correct `chatId`.
31. Click **Skills** in the header. Add a personal skill: name it (for example `spike-fact`), give it a one-line description, choose "Paste content", and enter an instruction body containing a fact the model has no other way to know (for example "The demo passphrase is TURQUOISE-NARWHAL-77."). Confirm it appears in "Your skills" immediately after submitting.
32. Start a new chat and ask a question that matches the skill's description (for example "What is the demo passphrase?"). Confirm the reply includes the exact fact from step 31, and that a chip labeled with the skill's name appears in the transcript below the assistant's text.
33. Back on the **Skills** page, delete the skill from step 31 and confirm it disappears from the list.
34. Sign out and sign back in as `ADMIN_EMAIL`. Open the **Admin console** and, in the "Enterprise skills" section, add a skill the same way. Sign out, sign back in as a non-administrator identity, start a new chat, and confirm asking the same matching question also activates it -- an enterprise skill is visible to every identity, not only the administrator who added it.
35. Under **R2** > `<DEMO_NAME>-files`, confirm an object exists under a `skills/enterprise/<id>/SKILL.md` key for step 34's skill, and that no `skills/personal/<your-email>/` prefix remains from step 31's skill -- step 33's deletion removed its backing object along with its D1 row.

## Provisioned Resources

- Worker (`<DEMO_NAME>`) serving the Vue shell as static assets and a Hono API.
- `CHAT_AGENT` Durable Object binding (`ChatAgent`, one instance per chat, `new_sqlite_classes` migration `v1`) -- created by Wrangler on first deploy, not Terraform (AGENTS.md, Resource Ownership).
- D1 database `<DEMO_NAME>-db`, bound as `DB`, holding the `users` table (its `business`/`geo` columns, Phase 7, are nullable application-level enums with no `CHECK` constraint), `chats`, `chat_usage` (this demo's per-turn cost ledger, Phase 6), `chat_files` (agent-generated file metadata, Phase 9), and `skills` (personal/enterprise skill management metadata, Phase 11 -- the model-visible catalog itself lives in R2, read directly by `agents/skills`, never from this table).
- AI Gateway `<DEMO_NAME>`, bound to the Worker as the `AI_GATEWAY_ID` var. Its two dynamic routes (`<DEMO_NAME>-basic`, `<DEMO_NAME>-reasoning`, bound as `AI_GATEWAY_ROUTE_BASIC`/`AI_GATEWAY_ROUTE_REASONING`) are what every chat turn now actually calls, selected per chat by the "Mode" dropdown ("Basic"/"Reasoning") rather than a raw model id. Each route now also carries a `business-check` conditional element and a rate-limit element (Phase 8, US-7) that steer the caller's admin-assigned business segment to one of two models per route; the gateway itself carries a $1/day spend limit partitioned by the same `business` metadata dimension.
- `CLOUDFLARE_API_TOKEN` Worker secret and `CLOUDFLARE_ACCOUNT_ID` var, used only by `ChatAgent.reconcileUsage()`'s one direct REST call to AI Gateway's logs-list endpoint (no binding lists logs) to read back a turn's authoritative logged cost.
- R2 bucket `<DEMO_NAME>-files`, bound to the Worker as `FILES` (Phase 9) -- agent-generated files under a `chats/` prefix (`ChatAgent`'s own `writeMarkdown` tool), and, from Phase 11, personal/enterprise skill content under a disjoint `skills/` prefix (`skills/enterprise/<id>/SKILL.md`, `skills/personal/<owner>/<id>/SKILL.md`), read directly by `agents/skills`'s own `r2()` source -- no second bucket or Terraform resource was needed for this phase.
- `LOADER` Worker Loader binding (`worker_loaders`, Phase 10) -- the `getUrl` tool's sandboxed Dynamic Worker, whose `globalOutbound` is the `EgressGateway` `WorkerEntrypoint` also exported from this Worker. Needs no Terraform resource: it is a pure `workerd` runtime primitive with no account-level proxy step (Spike C), but does need the account on a Workers Paid plan or above (see Prerequisites).
- Custom domain `<DEMO_NAME>.<DEMO_DOMAIN>`.
- Access application + allow policy requiring authentication for the whole hostname, with `audience` pinned.
- Workers Logs (100% sampling) and traces (10% sampling).

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| Access denies sign-in | Confirm `CLOUDFLARE_TEAM_DOMAIN` and that an identity provider is enabled in the target Zero Trust organization, then re-run `npm run deploy`. |
| `401` from `/api/me` | Sign in through Access at `https://<DEMO_NAME>.<DEMO_DOMAIN>`; every API route requires a verified Access identity. |
| Domain fails to provision | Remove the conflicting DNS record and confirm the supplied zone ID owns `DEMO_DOMAIN`. |
| `generate:wrangler` fails during deploy | Run `npm run deploy:infra:apply` successfully first; every referenced Terraform output must exist. |
| D1 migration fails during deploy | Confirm Terraform apply completed (the D1 database must exist) before `db:migrate:remote` runs; re-run `npm run deploy`. |
| `vite dev`/`vitest` hang or fail to reach Workers AI | The `AI` binding has no local simulator and always reaches the real account; confirm the token has `Workers AI : Edit`. |
| Signed in but no `Administrator` badge | Confirm you signed in with the identity matching this deployment's `ADMIN_EMAIL`, and that D1 migrations have applied. |
| Composer stays disabled after sending the first message | The chat WebSocket has not reported `connected` yet; check the browser console/Workers Logs for a rejected upgrade (for example an expired Access session). |
| Sidebar shows "No chats yet" after a fresh deploy or teardown/re-deploy | Expected: the chat directory is a D1 table, so a freshly re-provisioned database starts empty; click **+ New Chat**. |
| A chat never acquires a title | Auto-titling is a best-effort second Workers AI call after the first turn (docs/06-AGENTIC-CHAT.md Section 11); check Workers Logs for a `chat_title_failed` entry -- the conversation itself is unaffected either way. |
| "Mode" dropdown is disabled and a route change returns `422` | Expected once a chat has a completed turn -- a chat's route can only be changed before its first turn finishes (docs/06-AGENTIC-CHAT.md Phase 4); start a new chat to pick a different mode. |
| A chat turn fails with an AI Gateway error after changing the dynamic route's model in the dashboard | Not every Workers AI model works when called through a dynamic route's model node (`spikes/01-ai-gateway-dynamic-routing/REPORT.md` Section 4); pick a model confirmed there, or re-verify a new one before assigning it to the route. |
| Clicking the microphone control shows "Voice dictation is not supported in this browser" | The browser lacks `MediaRecorder`/`navigator.mediaDevices.getUserMedia` (for example a very old browser, or a non-HTTPS context other than `localhost`); use a current browser over HTTPS. |
| Clicking the microphone control shows "Microphone permission was denied" | Grant microphone access for this site in the browser's own site-permission settings, then click the control again -- the error clears the moment a new recording attempt starts. |
| A dictation returns "Workers AI could not transcribe the submitted audio" | A transient Workers AI failure; try again. Check Workers Logs for the underlying error if it persists. |
| A chat's cost badge stays "Estimated" forever | Expected in local development: the committed `.dev.vars` deliberately holds no secrets, so `CLOUDFLARE_API_TOKEN` is unset locally and `reconcileUsage()`'s REST call to AI Gateway's logs-list endpoint fails every attempt, exhausting its bounded retry budget (`docs/06-AGENTIC-CHAT.md` Section 6.6). Deployed, this should flip to "AI Gateway" within about 10-40 seconds of the turn completing; if it does not, confirm `npm run deploy:worker:secrets` actually ran (check Workers Logs for a `usage_reconcile_lookup_failed` entry) and that the token has `AI Gateway : Edit`. |
| No "Admin console" link in the header | Confirm you signed in with the identity matching this deployment's `ADMIN_EMAIL` -- the link is only ever hidden for a non-administrator identity, never a route guard (docs/06-AGENTIC-CHAT.md Section 6.5). |
| `/admin` loads but every section shows an error instead of a table | Expected for a non-administrator identity: Cloudflare Access itself does not block the page (there is only one Access application on this hostname), but `requireAdmin()` rejects every `/api/admin/*` request with `403` -- sign in as `ADMIN_EMAIL` instead. |
| `PATCH /api/admin/users/:email` returns `404` | The target email has never signed in, so it has no `users` row yet -- ask that user to sign in once first. |
| `PATCH /api/admin/users/:email` returns `400` | `business`/`geo` must each be one of their valid enum literals (`field`/`product`/`leadership`; `emea`/`apac`/`americas`) or explicit `null` -- both fields are always required together, per `docs/06-AGENTIC-CHAT.md` Phase 7. |
| `terraform apply` reports "No changes" after editing `infra/agentic-ai-chat.tf`'s route `elements` | Expected on a deployment that already applied a pre-Phase-8 state: `lifecycle { ignore_changes = [elements] }` (Spike B, Gotcha 3) means a plain `apply` never picks up a route-shape change. Run `terraform -chdir=infra apply -replace=cloudflare_ai_gateway_dynamic_routing.basic -replace=cloudflare_ai_gateway_dynamic_routing.reasoning` once to land Phase 8's `business-check`/rate-gate elements, then `npm run deploy` as usual. A brand-new deployment needs no such step -- its very first `apply` already includes them. |
| A chat's turn always resolves to the stronger, more expensive model regardless of business | Expected for a caller whose `business` is `null` (never assigned) or anything other than exactly `"field"` -- Phase 8's conditional treats every non-`"field"` value (including unset) as the stronger tier; assign `"field"` via the Admin Console to see the cheaper tier instead. |
| A burst of turns from the same business segment suddenly resolves to the cheaper model | Expected: Phase 8's rate-limit element (`limit = 3`, `window = 60`, keyed per `business` value) falls back to the cheap model once that segment's own 60-second bucket is exhausted -- wait for the window to reset, or use a different business segment to see the stronger model again immediately. |
| Asking the agent for a document produces text but no attachment chip | Check Workers Logs for a `write_markdown_r2_failed`/`write_markdown_d1_failed` entry (docs/06-AGENTIC-CHAT.md Section 11) -- the tool call itself reports a structured failure back to the model rather than crashing the turn, so the assistant's own reply usually explains it; confirm the token has `Workers R2 Storage : Edit`. |
| `GET /api/chats/:id/files/:fileId` returns `404` for a file you just created | Confirm you are signed in as the chat's owner and are requesting the file under the same chat id it was created in -- both are checked, and either mismatch reports the same `404` as a nonexistent file (docs/06-AGENTIC-CHAT.md Phase 9). |
| Asking the agent to fetch a URL fails with a Dynamic Workers/Worker Loader error | Confirm the account is on a Workers Paid plan or above (`developers.cloudflare.com/dynamic-workers/pricing/`) -- see Prerequisites. |
| Asking the agent to fetch an allow-listed URL is still refused | The allow-list (`src/worker/egress/allowlist.ts`) is an exact hostname match with no wildcarding -- confirm the URL's hostname is listed exactly (for example `developers.cloudflare.com`, not a subdomain or a redirect target of it). |
| Adding a skill returns `422` "A skill named ... already exists in this scope" | Names must be unique within their own scope (every enterprise skill together, or one owner's own personal skills) -- pick a different name, or delete the existing one first (`docs/06-AGENTIC-CHAT.md` Phase 11). |
| A newly added or just-deleted skill has no effect on the very next message | `agents/skills`'s own R2 listing is cached for up to 60 seconds (Spike D, `spikes/03-agent-skills-composability/REPORT.md` Section 4) -- send another message a little later, or start a new chat, which builds a fresh catalog. |
| Adding a skill from a URL fails with `400` | The URL must be an absolute `http`/`https` URL, reachable, and not resolve to an obviously-internal address (the same floor `getUrl` applies, `src/worker/egress/url-validation.ts`) -- confirm the URL is public and returns a non-empty body. |
| The agent never calls `activate_skill` even though a matching skill exists | Confirm the skill's description clearly states when to use it -- only `name`/`description` land in the system prompt (never the full instruction body) until the model actually activates it. |

## Teardown

```sh
cd demos/agentic-ai-chat
npm run teardown
```

`npm run teardown` first runs `preteardown:r2` (`empty-r2-bucket`, reading the `<DEMO_NAME>-files` bucket name and account id from Terraform outputs) to empty the R2 bucket -- Cloudflare refuses to delete a non-empty bucket -- then `terraform destroy -auto-approve`, removing the Worker, D1 database, R2 bucket, AI Gateway and its dynamic routes, custom domain, and Access application/policy, then deletes the locally generated `wrangler.jsonc` and `worker-configuration.d.ts`. Confirm no `<DEMO_NAME>` Worker, D1 database, R2 bucket, AI Gateway, or Access application remain in the account before discarding local Terraform state.

See `EXPLAIN-DEMO.md` for what this demo teaches and how it works, and `DEMO.md` for a presenter's demo script.
