# Ignite CRM — API/BFF Worker specification

## 1. Purpose and boundary

The API Worker is the public browser backend, static-asset host, authentication boundary, and
cross-service use-case coordinator. It shapes HTTP into typed RPC calls and returns SPA view models.
It owns no business database and contains no domain rules that belong to a service.

It is a backend-for-frontend, not a generic public integration API. External integrations are out of
scope. The browser never calls domain Workers directly.

## 2. Technology and internal architecture

Vue static assets and Hono API run in one Worker configured by Vite/Cloudflare plugin.

```text
Access + request ID + logging + body/same-origin middleware
  → Hono routes (HTTP validation/shaping)
    → application coordinators/use cases
      → typed CRM / Projects / Notes / Permissions ports
        → service bindings
```

Use `@demos/worker-common` for Access middleware, current identity, base `/api/me`, JSON body
limits, parsing, RFC 9457 handlers, and logging. `createMeRouter()` returns only its supported
primitive identity fields. Rich role/capability data lives at `GET /api/v1/session`, because the
shared router intentionally rejects structured additional fields. The composition root alone reads
bindings. Route handlers receive coordinators and do not construct adapters.

## 3. Authentication and request pipeline

Order is fixed:

1. request ID (accept a valid UUID `X-Request-ID`, otherwise generate);
2. structured request logger;
3. security headers/CSP;
4. Access verification with exact `ACCESS_AUD` and production dev tokens disabled;
5. resolve verified email through Permissions to create `ActorContext`;
6. same-origin check for unsafe browser methods;
7. route-specific body limit and JSON parsing;
8. input schema validation;
9. coordinator;
10. RFC 9457 error mapper.

Any inbound identity/user/role header is deleted before trusted context is established. Routes never
read actor identity from path/body/query.

## 4. HTTP contract

Base `/api/v1`. All list endpoints accept `cursor`, `limit`; filters are endpoint-specific. All
mutations return the current resource and use `Idempotency-Key`. PATCH/DELETE require `If-Match`.

### Identity and administration

| Method/path                      | Purpose                                            |
| -------------------------------- | -------------------------------------------------- |
| `GET /api/me`                    | Shared primitive verified-identity response        |
| `GET /api/v1/session`            | Resolved user, role summaries, UI capability flags |
| `GET /api/v1/users`              | Owner user list                                    |
| `POST /api/v1/users/invitations` | Invite user with seeded roles                      |
| `PATCH /api/v1/users/:id/roles`  | Replace roles; requires user ETag                  |
| `PATCH /api/v1/users/:id/status` | Suspend/reactivate/delete; requires user ETag      |
| `GET /api/v1/roles`              | Seed roles and descriptions                        |

### CRM

CRUD routes for `/contacts`, `/companies`, `/deals`; outcome action `POST /deals/:id/outcome`;
activities collection `/activities`; contact follow-ups `/contacts/:id/follow-ups`; action stream
`/action-stream`; report `/reports/pipeline`.

`POST /deals/:id/convert-to-project` owns the saga and returns `201` with project when fully linked,
or `202` with project plus `sourceLinkState: pending` when project creation committed but CRM
backlink needs retry. `POST /deals/:id/conversion/retry` resumes using the original project ID.

### Projects/tasks

CRUD-like routes `/projects`, `/projects/:id`, `/projects/:id/tasks`, `/tasks/:id`; task transition
`POST /tasks/:id/move`; `/my-work`; `/reports/delivery`. Archive is `POST /projects/:id/archive`,
not DELETE.

### Notes

`GET/POST /notes`, `GET/PATCH/DELETE /notes/:id`, `PUT /notes/:id/links`, `GET /notes/search`, and
`GET /resource/:type/:id/notes`. Create/replace links validates grouped target refs through CRM,
Projects, and Notes before calling Notes. Replacing with an empty link set is a 400 validation
error.

### Audit

`GET /api/v1/audit` requires `audit.read`, fetches bounded pages from Permissions, CRM, Projects,
and Notes concurrently, merges by `(createdAt,id,service)`, and returns a composite cursor
containing one opaque child cursor per service. A service outage fails the audit request; security
history is never partial.

### Composite records

`GET /customers/:contactId/overview` concurrently requests contact/company/deals/activities,
projects, and notes. Core CRM failure fails the request. Projects/Notes failure returns `200` with
`partial: true`, empty affected section, and stable `warnings[]`; authorization failures are never
downgraded to partial success.

## 5. HTTP details

- Successful create `201`; conversion pending `202`; delete `204`; reads/updates `200`.
- ETags are quoted integer versions. Missing `If-Match` is 428; stale is 409.
- Validation uses RFC 9457 with `type`, `title`, `status`, `detail`, `instance`, `requestId`, and
  optional `errors[{field,code,message}]`.
- Idempotency replay is checked before ETag/version conflict. A same-key/same-payload retry can
  return the stored success even though its `If-Match` version is now stale.
- Non-enumerating policy maps invisible/absent resource to the same 404.
- API never returns service stack, raw exception, SQL, binding names, or authorization reason
  detail.
- `Cache-Control: no-store` on authenticated API. Static hashed assets are immutable; `index.html`
  revalidates.
- Search query and filter parameters have allowlisted lengths/enums.

## 6. View-model composition

RPC records remain domain-oriented. API DTOs add display labels/capabilities and links. Hydration is
batched: collect unique refs, call each owner once (max 100), then join in memory. No N+1 RPC.
Capability flags are presentation hints derived from batch authorization; services still authorize.

A dependency deadline wrapper caps each domain RPC at 5 seconds. Independent calls use
`Promise.allSettled` only where partial response policy is explicit. Mutation dependencies fail fast
and do not use partial success except the documented conversion saga.

## 7. Static assets, routing, and security headers

- `/api/*`, OAuth/MCP paths, and unknown file-like paths never fall through to SPA index.
- Other navigation paths serve `index.html` for Vue Router history mode.
- CSP:
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
  (adjust only for build requirements, never `unsafe-eval`).
- Add HSTS in production, nosniff, strict referrer policy, and restrictive permissions policy.
- Markdown rendering is client-side from raw Markdown under the same sanitization contract; API does
  not emit HTML.

## 8. Testing

### Unit

Route validation, status/error mapping, ETags, body limits, origin checks, ref grouping, label
hydration, partial response policy, conversion state machine, and no fallthrough.

### Coordinator integration with mocks

Each service binding is represented by a typed fake that passes its contract suite. Test normal,
forbidden, not found, conflict, timeout, malformed dependency result, and one-dependency failure.
Assert exact calls and actor propagation; no tests mock private implementation modules.

### Workers-runtime

- Real Hono Worker with fake service Workers via service bindings.
- Access development JWT signing including wrong audience, expiry, missing JWT, smuggled differently
  cased identity header.
- Full real-service suite for invite → contact/deal → win → convert → task → multi-linked note →
  customer overview.
- Static asset deep link, API 404, CSP, caching.
- Finite 30-second timeout, local only.

## 9. Acceptance criteria

- API owns no D1 or business table.
- Every route authenticates and every service call carries the resolved ActorContext.
- Every mutation has idempotency and concurrency semantics.
- Composite hydration uses bounded batch calls.
- Partial responses occur only on documented read composites.
- Browser can perform all Must-have stories without direct service access.

## 10. Open questions

1. Should the API expose OpenAPI documentation? Current decision: generate an internal checked
   document from route schemas, but do not expose a public Swagger UI in release one.
2. Should conversion pending return 202 (current decision) or block/retry until a terminal 201/503?
3. Should project/note failure make customer overview partial (current decision) or fail the whole
   page?
4. Should owner user administration live under `/admin/*` rather than resource routes? Current
   decision: capability-based resource routes; UI path may still be `/admin`.
5. Confirm five-second per-RPC deadline and 8 KiB default/64 KiB note body limits.
6. Is CSV export (Could-have) excluded from this release's route contract? Current decision: yes.
