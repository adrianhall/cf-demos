# Ignite CRM — First-release engineering specification

## 1. Status and authority

This document is the system-level engineering contract for the first release described in
[`00-introduction.md`](./00-introduction.md). The service specifications refine it:

| Document                                                     | Deployable unit                         |
| ------------------------------------------------------------ | --------------------------------------- |
| [`01a-permissions-spec.md`](./01a-permissions-spec.md)       | Permissions/identity Worker             |
| [`01b-crmservice-spec.md`](./01b-crmservice-spec.md)         | CRM data Worker                         |
| [`01c-projectservice-spec.md`](./01c-projectservice-spec.md) | Projects Worker                         |
| [`01d-notesservice-spec.md`](./01d-notesservice-spec.md)     | Notes Worker                            |
| [`01e-api-spec.md`](./01e-api-spec.md)                       | Public API/BFF Worker and static assets |
| [`01f-mcp-spec.md`](./01f-mcp-spec.md)                       | Remote MCP Worker                       |
| [`01g-spa-spec.md`](./01g-spa-spec.md)                       | Vue SPA                                 |
| [`01h-oauth-spec.md`](./01h-oauth-spec.md)                   | OAuth authorization Worker              |

A child spec is authoritative inside its service boundary. This document is authoritative for
cross-service rules. A conflict is resolved by changing both documents in one review; implementation
must not silently choose one.

Normative terms **MUST**, **SHOULD**, and **MAY** have their RFC 2119 meanings. Open questions do
not suspend an explicit decision unless the question says that it is blocking.

## 2. Fixed implementation decisions

1. The demo lives at `cf-terraform-demos/ignite-crm` and is one pnpm workspace package containing
   several deployable Workers. It uses the repository-root `.env`, Oxfmt, type-aware Oxlint, Vitest,
   the `cf` CLI, Cloudflare Vite plugin, and Terraform. Wrangler is forbidden.
2. The browser application is **Vue 3**, TypeScript, Composition API, `<script setup>`, Vue Router,
   and Vite. React has no product-specific advantage here.
3. Public HTTP exists only on the API, MCP, and OAuth authorization-server hostnames. Domain Workers
   expose no useful `fetch()` surface; all domain calls use typed Workers RPC service bindings and
   `WorkerEntrypoint`.
4. The deployable units are `api`, `oauth`, `mcp`, `permissions`, `crm`, `projects`, and `notes`.
   The SPA is served as API Worker static assets, not deployed independently. Each Worker has its
   own directory and typed `cloudflare.config.ts`; `cf` configuration supports one Worker per file.
   A root Vite build imports those definitions into one entry-plus-auxiliary-Workers build output
   for local development and production build. Cross-config imports always include the `.ts`
   extension.
5. Each stateful domain Worker owns one dedicated D1 database. No Worker receives another service's
   D1 binding. D1 read replication is disabled for release one so authorization-sensitive reads do
   not introduce replica-consistency ambiguity.
6. Durable Objects are **not used in release one**. None of the first-release use cases requires
   WebSockets, per-entity coordination, or stronger consistency than one D1 transaction. This is a
   deliberate demonstration that microservices do not imply Durable Objects. Scheduling and live
   collaboration may add them later.
7. The API and MCP Workers are stateless composition layers. They do not own business data or copy
   domain tables. The OAuth Worker owns only authorization grants/tokens in a dedicated KV
   namespace; that security state is not business data.
8. Authentication uses Cloudflare Access. The API and OAuth sign-in/consent surface validate the
   Access JWT and exact application audience through `@demos/worker-common`. The OAuth Worker uses
   `OAuthAuthorizationServer` from `@cloudflare/workers-oauth-provider` v1; MCP uses
   `OAuthResourceServer` over a typed `AUTH_SERVER` binding plus the current stateless
   `createMcpHandler`. Deprecated `OAuthProvider`, `McpAgent`, and MCP SDK v1 are forbidden.
9. Authorization uses the permissions service on every domain-service operation. UI hiding is never
   an authorization control. To avoid contradictory rules, only the target domain service performs
   the authoritative authorization check for that operation; API/MCP capability checks are optional
   presentation/preflight hints and are never trusted as proof.
10. IDs are lowercase UUID strings generated with `crypto.randomUUID()`. Times are UTC ISO 8601
    strings. Date-only fields use `YYYY-MM-DD`. Money is integer minor units plus ISO 4217 currency.
11. Deletes are soft deletes (`deleted_at`, `deleted_by`) unless a child spec explicitly identifies
    an immutable join/audit row that can be physically removed. Normal reads exclude deleted rows.
12. Every mutating public request and MCP tool accepts an idempotency key. The API generates one
    when a browser omits it; MCP tools require or generate a stable key for the tool invocation.
13. Pagination is cursor based, stable, and bounded: default 50, maximum 100. Cursors are opaque
    base64url JSON containing the ordered tuple; clients must not construct them.
14. Each service owns its audit rows and exposes an authorized audit-page RPC. The API's audit view
    fans out and merges pages; there is no distributed audit database in release one.
15. All Workers pin compatibility date `2026-10-07` with `nodejs_compat`. This date enables enhanced
    RPC error serialization by default (required by §5.3); providers and consumers must use the same
    date/behavior. All audit messages must also be logged through the standard logger at an
    appropriate level.

## 3. System context and trust boundaries

```mermaid
flowchart LR
    Browser[Vue SPA] -. HTTPS + Access JWT .-> API[API Worker]
    Client[MCP client] -. OAuth 2.1 / Streamable HTTP .-> MCP[MCP Worker]
    Client -. OAuth discovery and consent .-> OAuth[OAuth authorization Worker]
    MCP -->|token validation RPC| OAuth

    API --> Permissions
    API --> CRM
    API --> Projects
    API --> Notes
    MCP --> Permissions
    MCP --> CRM
    MCP --> Projects
    MCP --> Notes
    CRM --> Permissions
    Projects --> Permissions
    Notes --> Permissions
    Projects --> CRM
```

Trust rules:

- Browser input, MCP arguments, Access headers, OAuth metadata, cursors, and IDs are untrusted.
- API/MCP establish an `ActorContext`; domain services never accept identity from business payloads.
- Service bindings are private transport, not authorization. A called service MUST authorize.
- Only composition Workers may coordinate multiple domain services. A domain service may call a
  dependency shown above for a domain invariant, never to bypass its public contract.
- No service may expose D1, repository objects, SQL row shapes, or framework contexts over RPC.

## 4. Project organization

```text
cf-terraform-demos/ignite-crm/
├── package.json                         # required lifecycle and per-Worker scripts
├── tsconfig.json                        # strict project references
├── oxlint.config.ts                     # extends root; typeAware + typeCheck
├── vite.config.ts                       # entry API + six auxiliary Workers + SPA
├── vitest.config.ts                     # unit/DOM/contract projects
├── vitest.integration.config.ts         # one finite-timeout project per main Worker
├── infra/
│   ├── providers.tf
│   ├── access.tf
│   ├── api.tf
│   ├── oauth.tf                         # Worker + OAuth KV + auth hostname
│   ├── mcp.tf
│   ├── permissions.tf
│   ├── crm.tf
│   ├── projects.tf
│   ├── notes.tf
│   ├── outputs.ts                       # typed scalar-output reader shared by configs
│   ├── outputs.tf
│   └── local-outputs.json               # committed placeholders for every binding
├── migrations/{permissions,crm,projects,notes}/
├── src/
│   ├── contracts/{common,permissions,crm,projects,notes}.ts
│   ├── workers/
│   │   ├── api/{cloudflare.config.ts,middleware,routes,composition,index.ts}
│   │   ├── oauth/{cloudflare.config.ts,consent,index.ts}
│   │   ├── mcp/{cloudflare.config.ts,auth,tools,composition,index.ts}
│   │   ├── permissions/{cloudflare.config.ts,domain,application,infrastructure,index.ts}
│   │   ├── crm/{cloudflare.config.ts,domain,application,infrastructure,index.ts}
│   │   ├── projects/{cloudflare.config.ts,domain,application,infrastructure,index.ts}
│   │   └── notes/{cloudflare.config.ts,domain,application,infrastructure,index.ts}
│   └── client/{components,composables,router,services,views,App.vue,main.ts}
└── tests/
    ├── fixtures/
    ├── fakes/                            # typed in-memory RPC dependency fakes
    ├── unit/{permissions,crm,projects,notes,api,oauth,mcp,client}/
    ├── contract/                         # every real service and fake vs same suite
    ├── integration/                      # one main TS Worker + built JS auxiliaries
    └── built-workers/                    # generated by cf build; gitignored
```

Rules:

- Each `cloudflare.config.ts` exports a named `defineWorker()` value and defaults
  `defineConfig({worker})`. Consumers import that value (with `.ts` extension) and use
  `bindings.worker({worker, exportName})`, preserving RPC types. The Vite `auxiliaryWorkers` entries
  use those same definitions through programmatic config; there are no Wrangler config files.
- `src/contracts` contains value-only TypeScript: serializable interfaces, enums, input/output
  shapes, and service ports. It imports no Hono, Vue, D1, Worker binding, or implementation module.
- Every service follows `entrypoint → application service → domain → repository port → D1 adapter`.
- Entrypoints construct services once per invocation from `this.env`. Route/tool handlers never
  construct repositories.
- Cross-service dependencies are interfaces from `src/contracts`, injected into application
  services. Tests supply fakes without workerd; integration tests bind real Workers.
- A service's SQL migrations remain under its own directory and cannot reference another database.
- Generated binding types under `.cloudflare/` are included in TypeScript and never hand-written.

## 5. Shared RPC contract

### 5.1 Actor and request context

Every public RPC method's first parameter is:

```ts
interface ActorContext {
  /**
   * Verified, normalized lower-case Access identity.
   */
  readonly email: string;
  /**
   * Stable installation-local user ID resolved by permissions service.
   */
  readonly userId: string;
  /**
   * Correlation ID propagated through every service call.
   */
  readonly requestId: string;
  /**
   * Entry surface for audit and policy: browser or MCP.
   */
  readonly channel: 'api' | 'mcp';
}
```

The API/MCP obtains `userId` by calling `resolveActor(email)`. Domain services call `authorize()`
with `userId`, action, and resource context. They MUST NOT accept role names or permission lists
from the caller.

### 5.2 Values and serialization

RPC parameters and results MUST be plain structured-cloneable values. Do not return custom classes,
D1 results, Hono responses, callbacks, or long-lived `RpcTarget`s. Records larger than the bounded
page size are forbidden; exports, when introduced, use byte streams. Workers RPC has a 32 MiB
serialized-value limit, which is not a target.

The public contract uses:

```ts
type PageRequest = { readonly cursor?: string; readonly limit?: number };
type Page<T> = { readonly items: readonly T[]; readonly nextCursor?: string };
type MutationMeta = { readonly idempotencyKey: string };
type ResourceRef = {
  readonly type: 'contact' | 'company' | 'deal' | 'activity' | 'project' | 'task' | 'note';
  readonly id: string;
};
```

Every input is validated again in the callee. Unknown fields are rejected on create/update inputs to
catch agent and client drift rather than silently discard data.

### 5.3 Errors

Services throw errors with serializable own fields:

```ts
type ServiceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL';

interface ServiceErrorShape {
  readonly name: 'ServiceError';
  readonly code: ServiceErrorCode;
  readonly message: string; // safe for caller, no secrets/SQL
  readonly field?: string;
  readonly retryable: boolean;
  readonly requestId: string;
}
```

Callers inspect `name`/`code`, never `instanceof`, because RPC does not preserve prototypes. API
maps errors to RFC 9457: 400, 401, 403, non-enumerating 404, 409, 412, 503, 500. MCP returns
`isError` tool results with the same stable code and actionable text. Stack traces remain
server-side.

### 5.4 Idempotency and optimistic concurrency

- Every mutable aggregate has integer `version`, beginning at 1.
- Updates/deletes require `expectedVersion`; mismatch is `CONFLICT` with no write.
- Each service stores
  `(actor_id, operation, idempotency_key, request_hash, result_json, created_at)`.
- Idempotency lookup occurs **before** optimistic-version validation. Replaying the same key and
  same canonical input returns the stored success even when its `expectedVersion` is now stale (the
  normal lost-response retry). Same key with different input is `CONFLICT`. Records may be purged
  after 24 hours.
- A service transaction writes domain state, audit row, and idempotency result atomically using D1
  `batch()` or an equivalent repository transaction.

## 6. Cross-service workflows and consistency

There is no distributed transaction. Cross-service workflows are explicit sagas.

### Deal-to-project conversion

1. API reads an authorized `DealConversionSnapshot` from CRM. CRM checks `deal.convert` and requires
   `won`.
2. API calls Projects `createFromDeal(snapshot, idempotencyKey)`. Projects independently checks
   `deal.convert` and has a unique `source_deal_id`; replay returns the same project.
3. API calls CRM `recordProjectConversion(dealId, projectId, expectedVersion, idempotencyKey)`.
4. After the CRM backlink succeeds (or already points to this project), API calls Projects
   `markSourceLinkState(projectId, 'linked', currentProjectVersion, idempotencyKey)`. That
   restricted transition is the terminal commit marker for the saga.
5. A `201` is returned only when step 4 succeeds. If step 3 or 4 fails, API returns `202` with the
   usable project in `pending`. Retry re-reads the deal and project with their **current** versions,
   confirms the deal is won and unlinked or linked to this project, completes whichever step is
   missing, and never reuses a stale snapshot version.
6. A conflict showing another project already linked is surfaced; no second project is created. A
   pending project may remain pending indefinitely until an owner/manager retries; this accepted
   release-one state is visible in the project UI and `saga.pending` metric, not silently hidden.

### Note creation with links

1. API groups requested links by owner service.
2. CRM and Projects validate that targets exist and the actor may read them, returning normalized
   `ValidatedResourceRef` values.
3. API calls Notes once with the validated set. Notes re-authorizes `note.create` and writes the
   note plus all links atomically.
4. Notes never copies target display names as authoritative data. API hydrates result context by
   RPC; unavailable targets render as typed IDs with a partial-data warning.

`ValidatedResourceRef` is not a capability and Notes does not attempt to authenticate that value.
The trusted composition boundary (API/MCP) MUST construct it only from owner-service validation and
MUST never deserialize/forward a client-supplied validated ref. Notes independently checks
`note.write`; target-level visibility is composition-layer authorization by explicit design.
Contract and integration tests must prove public API/MCP schemas cannot express validator metadata.

### Deletion

Cross-service links are intentionally non-cascading. Soft deletion of a CRM/project record leaves a
note link as a tombstoned reference so history remains auditable. UI hydration labels it deleted.
Physical purge is out of scope.

## 7. Public API conventions

The detailed routes are in `01e`. Shared rules:

- Base path `/api/v1`; JSON uses `application/json`; errors use `application/problem+json`.
- `Idempotency-Key` is accepted on mutations; `If-Match: "<version>"` is required for update/delete.
- Responses include `X-Request-ID`; lists use `cursor` and `limit`.
- Body limit is 8 KiB by default; note Markdown is explicitly capped at 64 KiB and uses a
  route-level larger limit. Uploads do not exist.
- Unknown routes use the shared RFC 9457 not-found handler. No stack or upstream message is
  returned.
- Browser mutations require same-origin checks in addition to Access.
- The API returns composite view models; it does not expose raw RPC contracts by accident.

## 8. Security and privacy

- Terraform owns one authenticated Access application for the SPA/API paths and OAuth/Access
  resources for MCP. Production never enables development tokens.
- In local development, `cloudflareAccessPlugin` signs development JWTs so the production auth path
  stays active.
- The exact Access audience is a Terraform scalar output and a typed binding.
- Email is normalized to Unicode-trimmed lowercase. Display names are never authorization keys.
- Markdown is stored raw and rendered with HTML disabled, URL protocol allowlisting, and sanitized
  output. CSP forbids inline scripts and framing.
- D1 statements use parameter binding. Sort/filter fields come from allowlisted mappings.
- Logs contain IDs, action names, duration, outcomes, and request IDs; never note bodies, addresses,
  OAuth tokens, JWTs, or free-text status lines.
- List/read authorization is fail-closed. A permissions outage returns 503 and no business data.
- Services have no public routes, no `workers.dev` exposure, and no custom domains.

## 9. Observability

All Workers enable structured logs and traces. Every log event includes `timestamp`, `level`,
`service`, `operation`, `requestId`, `actorId` when known, `durationMs`, and `outcome`. RPC callers
add `dependency` and dependency duration. Each Worker emits:

- invocation count, latency, and failures by stable operation/error code;
- authorization denied count by action (without target details);
- D1 latency and rows read/written;
- idempotency replay/conflict count;
- saga pending/retry count (API, CRM, Projects);
- MCP tool calls and failures by tool name, never arguments.

Health is tested via RPC `health()` methods returning service/database/migration version. It is not
a public unauthenticated endpoint.

## 10. Testing strategy

### 10.1 Test layers

1. **Pure unit tests:** domain validation, policy matrices, sorting, cursors, state transitions.
2. **Application tests:** real use case with in-memory repository and typed fake dependencies.
3. **Adapter tests in Workers runtime:** real D1 migrations/repositories using
   `@cloudflare/vitest-plugin`, isolated storage, and `cloudflare:test`.
4. **Contract tests:** one reusable suite per RPC port. Run it against the real service entrypoint
   and every fake used by dependents; a fake that drifts fails CI.
5. **Service integration tests:** one real TypeScript service as the plugin's `main` Worker plus
   fake RPC dependencies, including timeout, forbidden, malformed-return, and retryable failure
   cases.
6. **System integration:** all seven Workers and four local D1 databases under the multi-Worker
   Vitest plugin. Because auxiliary Workers cannot have TypeScript entrypoints or import
   `cloudflare:test`, `pretest:integration` runs `cf build` and points auxiliaries at generated JS;
   the main test context applies all four migrations through D1 bindings shared with the relevant
   auxiliary Workers. Separate projects rotate API and MCP as the main Worker for their surfaces.
7. **DOM tests:** Vue Test Utils for views/forms/accessibility state.
8. **E2E smoke:** Playwright against local `pnpm start`; no live infrastructure.

Every integration project has a finite 30-second test timeout. Tests are offline. Each
single-service suite applies its migrations with `readD1Migrations()`/`applyD1Migrations()`;
multi-Worker projects apply migrations from the main test context before invoking auxiliaries.
`tests/built-workers` is always generated and never committed.

### 10.2 Required failure tests

- forged actor fields in payload are ignored/rejected;
- permissions denial and permissions outage fail closed;
- duplicate idempotency replay and key/payload collision;
- stale version conflict;
- dependency timeout/unavailable and partial composite response policy;
- deleted linked records remain tombstoned;
- malformed cursor, oversized body/note, unknown fields;
- smuggled Access identity headers do not override verified identity;
- MCP token for wrong audience/scope cannot call a tool;
- every role/action matrix cell has an explicit allow/deny assertion.

## 11. Infrastructure and lifecycle

Terraform owns seven Worker registrations, four D1 databases, one OAuth KV namespace, three custom
hostnames (API, OAuth issuer, MCP resource), DNS, and Access infrastructure. `cf`/Vite owns code,
static assets, service bindings, D1/KV bindings, and deploy-time Worker configuration. One Terraform
file per Worker plus `access.tf`, `providers.tf`, and scalar `outputs.tf` is mandatory. Each Worker
resource explicitly depends on its Terraform-managed binding resources. API, OAuth, and MCP custom
domains each have stable bootstrap versions/deployments with `ignore_changes = all`.

Scalar outputs are named `permissions_d1_database_id`, `crm_d1_database_id`,
`projects_d1_database_id`, `notes_d1_database_id` (plus matching database names),
`oauth_kv_namespace_id`, Worker names, hostnames, and Access audiences. The committed
`infra/local-outputs.json` contains the same output shape with stable placeholder IDs.

The root migration helper handles one database per call, so scripts expose:

- `migrate:{permissions,crm,projects,notes}:local`, each passing its own `--output-key`, `--dir`,
  committed outputs, and `--local`;
- matching `migrate:*:remote` scripts reading `infra/outputs.json`;
- required aggregate `migrate:local` and `migrate:remote` scripts composed with `run-s`.

Lifecycle scripts:

- `start`: `migrate:local`, then one Vite/`cf dev` process whose API entry Worker includes all six
  auxiliary Workers, persisting to `.cloudflare/state`;
- `check:types`: run `cf workers types --mode development` for each Worker directory, then strict
  TypeScript; each generated `.cloudflare/types/index.d.ts` is explicitly included;
- `check`: `check:types`, Oxfmt check, type-aware/type-checking Oxlint, Terraform init/validate/fmt
  check, and a dry build;
- `fix`: regenerate types, Oxfmt write, safe Oxlint fixes, Terraform fmt;
- `test`: unit, DOM, contract, and Workers-runtime integration tests, including the generated
  auxiliary-Worker prebuild;
- `deploy`: Terraform apply → write outputs → `migrate:remote` → one Vite production build → seven
  explicit `cf deploy --prebuilt --mode production --worker <name>` steps. Deploy Permissions, CRM,
  Projects, Notes, OAuth, MCP, then API; every step is individually runnable;
- `teardown`: delete public API/MCP/OAuth Workers first, then domain Workers, then Terraform
  destroy.

Commands use `npm-run-all2` namespaced steps. Deploy/teardown are non-interactive and idempotent.

## 12. Performance and limits

- API target p95 excluding cold starts: reads <500 ms, single-service writes <750 ms, composites
  <1,500 ms locally measured; these are engineering budgets, not an SLA.
- Composite reads use parallel independent RPC calls. Writes with ordering requirements are serial.
- No endpoint may perform one RPC per list item. Services expose batch reads capped at 100 IDs.
- Search queries are 2–200 characters and return at most 50 notes.
- Notes are 64 KiB Markdown; status lines 160 characters; task/deal titles 200; activity
  summary 500.
- RPC results remain bounded and plain values; no unbounded table scans or responses.

## 13. Documentation and definition of done

Every exported member and meaningful helper has complete JSDoc per repository rules. README covers
prerequisites, topology, local/deploy/teardown, seeded users/roles, and trade-offs. A service is
done only when its independent tests, contract tests, integration tests, migrations, observability,
and child-spec acceptance criteria pass. System completion also requires clean deploy/teardown.

## 14. Open questions for system review

These can be decided independently unless marked blocking:

1. Should installation currency be fixed in configuration (current recommendation: `GBP`) or chosen
   once by the owner? Multi-currency deal aggregation is out of scope either way.
2. Should deleted business records remain restorable indefinitely (current decision), or should an
   owner-only purge operation be in release one?
3. Is 24 hours the correct idempotency retention window?
4. Should first release include the Should-have standalone-project flow, or leave it behind a
   feature flag while keeping the schema ready?
5. Should service traces be sampled at 10% in production or 100% for this educational demo?
