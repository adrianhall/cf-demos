# Ignite CRM — AI-enabled demo walkthrough

**Live application:** <https://ignite-crm.cfapps.uk/>. Cloudflare Access protects the entire
hostname; authenticate through the organization's identity provider. The first deployed sign-in as
the `ADMIN_EMAIL` configured in the repository-root `.env` bootstraps the owner. Other
Access-authenticated identities are provisioned read-only until an owner assigns a role. Invitations
pre-create users and assign roles; **no invitation email is sent**.

> [!IMPORTANT]
> The deployed D1 database starts **empty**. Northwind Traders, Priya Shah, and the five local
> identities below exist only under `pnpm start`: seed migrations are local-only and are never
> deployed. Create disposable records to evaluate the production site. Do not use customer data in a
> demo environment.

## Prerequisites and commands

From the repository root, run `pnpm install` and `pnpm create-env` if the root `.env` does not
already exist. Set the Cloudflare account, zone, team domain, API token, and `ADMIN_EMAIL`
documented in `.env.example`. Run these from `cf-terraform-demos/ignite-crm`:

| Command               | Purpose                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm start`          | Migrate and seed the **local** D1 simulation, then start both Workers and the SPA at `http://localhost:5173/`. Local state is `.cloudflare/state`.                  |
| `pnpm check`          | Types, formatting, linting, Terraform validation and formatting, development build, and the **non-writing enforced lazy-chat bundle budget**.                       |
| `pnpm report:bundles` | Run the same bundle checks and write the ignored `.cloudflare/bundle-report.json` release artifact.                                                                 |
| `pnpm test`           | Vitest with the 80%-per-file coverage gate, then Chromium E2E against separate local D1 state. On a new machine, first run `pnpm exec playwright install chromium`. |
| `pnpm deploy`         | Terraform apply → write outputs → remote D1 migration → production build → upload Data Worker then Application Worker.                                              |
| `pnpm teardown`       | Delete Application Worker, then Data Worker, **before** Terraform destroys infrastructure. Do not run against a retained demo unless removal is intended.           |

The E2E runner uses `.cloudflare/e2e-state` and port 5199, not your `pnpm start` data.
`vite.config.ts` reads `IGNITE_PERSIST_TO` so that its Worker opens that same migrated state. The
root `.env` is never read by local browsing and is never committed.

## Browser walkthrough

Use `owner@example.com` on the **local** Access login page, or the real `ADMIN_EMAIL` identity on
the deployed hostname. Local development also offers `manager@example.com`, `sales@example.com`,
`delivery@example.com`, and `readonly@example.com`. The responsive navigation drawer opens with the
menu button on mobile; all major routes are keyboard reachable.

1. **Dashboard and identity.** Confirm the signed-in name and role in the app bar. Open the account
   menu for **Your account** (verified e-mail, roles, capabilities) or **Sign out**. The dashboard
   shows counts, next actions, a pipeline summary by stage, and recently updated contacts. On a
   fresh production database these are zero, not seeded examples.
2. **Contact and company.** Open **Contacts → New contact** and enter a first name and a new company
   name. The contact opens with next action, deals, projects, activities, notes, and a merged
   timeline. Locally, open Priya Shah at `/contacts/00000000-0000-4000-8000-0000000000b1` and
   Northwind Traders to inspect populated views. A stale edit preserves its draft rather than
   overwriting a concurrent update.
3. **Sales and delivery.** Create a deal, view it in the board and list, and use the keyboard-first
   **Move** menu to change stage. Log an activity, set a next action, mark a deal won, and follow
   its converted delivery project. Add a task and change its fixed status with the same
   keyboard-first menu. Only managers/owners can archive a project.
4. **Notes and search.** Create a note linked to more than one record. Switch **Write/Preview**:
   Markdown is escaped/sanitized HTML; images do not load, unsafe links are not clickable, and task
   checkboxes are read-only. Search it in **Notes** and confirm it appears on every linked record.
5. **Team, audit, and reports.** As owner, add a teammate and assign a role. In **Audit trail**, see
   actor, timestamp, channel, versioned write and allowlisted metadata — never note bodies or free
   text. Open **Reports** for filterable pipeline, quarterly, and delivery aggregates; every seeded
   role, including read-only, has the report permission.

### Chat assistant walkthrough

1. Open a record, then choose the **Assistant** button in the app bar. On desktop it remains beside
   the record; on a phone it is a focus-managed overlay. `Esc` closes it and returns focus to the
   button.
2. Ask a grounded question, for example **“How is the pipeline?”**. See a compact tool-activity line
   such as “Totalled the pipeline”, then the assistant's answer. The assistant gets facts only from
   tools; it never receives CRM records in its prompt.
3. Ask it to change a disposable record, for example **“Write a note about this contact.”** It shows
   an approval card with the proposed action and arguments. Choose **Decline**: the card records
   that decision and no mutation reaches the CRM. Repeat and choose **Approve**: the note appears
   behind the panel and the audit row has channel **`chat`**.
4. Reload or close and reopen the panel: it rejoins the same per-user conversation. After three
   hours of inactivity, the Durable Object destroys the transcript; a returning tab says so once.
   This is intentional: the audit trail is the durable record of changes, not a chat log.
5. The Terraform-owned AI Gateway permits 30 model requests per rolling minute and has a $2 rolling
   daily cap. If it is temporarily unavailable or limited, the panel gives a safe unavailable
   message. It does **not** retry a mutation or approval continuation automatically; start a new
   action after recovery.

Local development and browser E2E use a deterministic development-only model so they work offline. A
deployed Worker uses Workers AI through the AI Gateway. This is a deliberate build-time split:
`import.meta.env.DEV` is statically false in every deployed bundle.

## MCP walkthrough and live-only validation

`POST /mcp` is a stateless Streamable HTTP MCP endpoint under the same Cloudflare Access policy as
`/api/*`. It is **not** a browser feature and it is not claimed as locally OAuth-tested: local
requests use a development JWT through the identical Worker policy list, while Managed OAuth itself
lives at the Access edge.

For a deployed validation, follow [MCP-VALIDATION.md](./MCP-VALIDATION.md). It covers Managed OAuth
and Dynamic Client Registration with a real client, capability-filtered discovery, one read and one
disposable write plus idempotency replay, audit `channel = mcp`, the 15-minute silent refresh, and a
suspended-user refusal. The runbook becomes evidence only when an operator records a dated outcome
against a deployment.

## Failure and accessibility checks

These checks are safe locally, or in production with disposable records:

- Submit a contact without a name or company, a deal without a primary contact, a note without a
  title/body/link, or a task with an invalid due date. The form keeps its draft and displays
  field-specific errors; no partial record is saved.
- Open the same deal or note in two tabs, save one, then submit the stale version in the other. The
  second write is rejected instead of silently overwriting the first.
- As a read-only identity, mutation controls and advertised write tools are absent. A direct write
  is still denied by the **Data Worker**, not merely hidden by the UI. Suspend a user and the next
  authenticated request fails closed.
- Simulate a Data Worker outage: it becomes retryable RFC 9457 `503` without SQL text or stacks. An
  expired Access session that returns HTML prompts **Sign in**, rather than being called a network
  failure.
- Use Tab/Shift+Tab, Enter/Space, and Escape throughout the assistant. The transcript is a polite
  live region, the composer has a label, approval cards state the proposed change before their
  buttons, and the open panel passes the same axe WCAG 2.2 AA pass as the main routes.

`pnpm test` exercises these outcomes offline against production service/repository SQL, genuine
Workers RPC/D1 and Durable Objects, and a browser. It includes the assistant's grounded read,
approval/replay/decline paths, session isolation, reconnection, expiry schedule, lazy bundle
boundary, open-panel axe scan, and desktop/mobile E2E journeys.

## Deployment and teardown checkpoint

The live checkpoint is intentionally manual because Managed OAuth and a real Workers AI call cannot
be proved offline:

1. Run `pnpm deploy`. If a fresh remote D1 migration hits the documented immediate 7403/403 race,
   wait 30 seconds and retry **only** `pnpm migrate:remote`, no more than three times.
2. On `https://<hostname>`, authenticate, perform a grounded chat read and an approved disposable
   chat write, then confirm its audit channel is `chat`.
3. Complete [MCP-VALIDATION.md](./MCP-VALIDATION.md), including the Managed OAuth refresh and
   suspended-user checks.
4. Confirm the AI Gateway configuration: logging enabled, cache disabled, 30/min sliding rate limit,
   and $2/24-hour sliding spend cap. Do not intentionally exhaust the production spend cap.
5. If this is a disposable deployment, run `pnpm teardown`; verify that both Workers are deleted
   before Terraform removes the D1 database, hostname, Access application/policies, and AI Gateway.
   The chat Durable Object namespace is an Application Worker export, so deleting that Worker
   retires the namespace and its sessions as part of its lifecycle.

A retained demo should record the deployment URL, UTC date, operator, MCP client/version, and
results outside source control. Never record Access tokens, OAuth client secrets, or customer
content.

### Phase 6 lifecycle evidence — 2026-10-14

A clean lifecycle rehearsal completed against this demo's account:

1. The pre-existing Application and Data Workers were deleted before Terraform destroy, leaving an
   empty Terraform state.
2. `pnpm deploy` recreated the D1 database, Access application/policy with Managed OAuth and Dynamic
   Client Registration, AI Gateway (30/minute and $2/day), bootstrap deployment/custom hostname,
   both Workers, all eight remote D1 migrations, and the `CrmChatAgent` Durable Object export.
3. The deployed hostname correctly required Access. An authenticated browser smoke test and Managed
   OAuth validation were deliberately **not** claimed: this session did not have the corporate IdP
   session needed to complete them. They remain the operator steps in
   [MCP-VALIDATION.md](./MCP-VALIDATION.md).
4. `pnpm teardown` then deleted the Application Worker, Data Worker, D1, Access resources, and AI
   Gateway. Terraform state was empty afterwards. The hostname no longer served the application.

This is lifecycle evidence, not Managed OAuth evidence. Do not replace the runbook's interactive
OAuth/refresh/suspension checks with this rehearsal.
