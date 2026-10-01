# Demo code rules

Rules for every demo in this repository. They apply to `cf-terraform-demos/`, `vinext-demos/`, and
`astro-demos/` alike. Family-specific conventions belong in that family’s `AGENTS.md`; demo-local
instructions document only behavior or constraints unique to one demo.

Each demo is a self-contained, deployable application that teaches good practice. Treat demo code as
production-quality reference material: someone will copy it.

## Repository layout

```text
<repo root>
├── .env                    # real credentials, never committed
├── .env.example            # documented template
├── oxfmt.config.ts         # formatting policy for every demo
├── oxlint.base.ts          # shared lint baseline for every demo
├── pnpm-workspace.yaml
└── <family>-demos/<demo>/  # one deployable demo per directory
```

## Package management

- **pnpm only.** Never use `npm` or `yarn`, and never commit their lockfiles.
- Demos are pnpm workspace packages. Install from the repository root with `pnpm install`.
- Pin versions deliberately. Use an exact version when a package is a pre-release or beta.
- Do not add a dependency to work around a problem that a first-party Cloudflare tool already
  solves.

## D1 migrations

For a D1-backed demo, use the repository-root migration helper; do not call `cf d1 migrations apply`
directly from a demo script.

- Add a scalar `d1_database_id` Terraform output and a matching value in the demo's committed
  `infra/local-outputs.json`.
- Bind D1 by that ID in `cloudflare.config.ts` in both local and production modes.
- Add these individually runnable demo scripts, adjusting the relative path only as needed:

  ```json
  {
    "migrate:local": "node ../../scripts/d1-migrate.ts --cwd . --outputs infra/local-outputs.json --local",
    "migrate:remote": "node ../../scripts/d1-migrate.ts --cwd . --outputs infra/outputs.json"
  }
  ```

- Run `migrate:local` before `cf dev`, and start `cf dev` with
  `--persist-to .cloudflare/state`.
- Run `migrate:remote` after Terraform writes `infra/outputs.json` and before building/deploying the
  Worker.
- Use `readD1Migrations()` from `@cloudflare/vitest-plugin` and `applyD1Migrations()` from
  `cloudflare:test` to apply migrations in Workers-runtime integration tests.

## Required scripts

Every demo's `package.json` must define these five scripts with these exact names and meanings:

| Script          | Purpose                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `pnpm start`    | Run the demo locally against local resource simulations.                    |
| `pnpm check`    | Verify everything without changing files. Must be safe to run in CI.        |
| `pnpm fix`      | Apply every automated correction (formatting, safe lint fixes, config gen). |
| `pnpm deploy`   | Provision infrastructure, then build and upload the application.            |
| `pnpm teardown` | Remove the deployed application, then destroy its infrastructure.           |

Rules for these scripts:

- `pnpm check` must cover, at minimum: TypeScript, Oxfmt (`--check`), Oxlint, and — when the demo
  uses Terraform — `terraform validate` and `terraform fmt -check`.
- `pnpm check` must never write files. `pnpm fix` is the only script that reformats or rewrites.
- `pnpm deploy` and `pnpm teardown` must be idempotent and non-interactive.
- `pnpm teardown` must delete the deployed application **before** destroying infrastructure, so
  provider APIs do not refuse to delete resources that are still bound to a live application.
- Compose multi-step scripts with `npm-run-all2` (`run-s`) and colon-namespaced sub-scripts
  (`check:types`, `deploy:infra`, …) so each step can be run and debugged individually.
- Add `pnpm test` whenever the demo has tests, which it normally should.

## Environment and credentials

- All demos read deployment settings from the **repository-root `.env`**. Never add a per-demo
  `.env`.
- `.env` is created by the user using `pnpm create-env` at the repository root and is never
  committed.
- Keep `.env.example` current, including the exact API-token permissions the demos need.
- A demo must not require a `.dev.vars` file. That file is normally untracked, so a fresh clone
  would behave differently from the author's machine. Prefer configuration that is either committed
  or absent by design.
- Derive per-demo values (worker name, hostname) inside the demo rather than adding more shared
  environment keys. A demo owns its own name; the shared `.env` owns the account and domain.
- Never print, log, or commit secrets. Never pass a token as a command-line argument.

## TypeScript

- TypeScript everywhere, with `strict` enabled. Also enable `noUnusedLocals`, `noUnusedParameters`,
  and `noFallthroughCasesInSwitch`.
- No `any` on public signatures, bindings, or handler parameters.
- Avoid `as unknown as T` double casts. If a cast feels necessary, the design is usually wrong.
- Do not hand-write generated types. Generate binding/config types from the platform tooling and
  include the generated file in `tsconfig.json`. Regenerate as part of `check:types`.
- Prefer explicit return types on exported functions and public methods.

## Formatting: Oxfmt

- Formatting policy lives in the **root `oxfmt.config.ts`** and applies to every demo.
- Do not add a per-demo Oxfmt config unless that demo genuinely needs different formatting. The
  nearest config wins and configs are not merged, so a local file silently replaces the shared
  policy.
- `pnpm check` runs `oxfmt --check .`; `pnpm fix` runs `oxfmt --write .`.
- Never hand-format code to fight the formatter.

## Linting: Oxlint

- Shared, framework-neutral rules live in the **root `oxlint.base.ts`**.
- Each demo has its own `oxlint.config.ts` that extends the shared baseline and adds
  framework-specific plugins, rules, and ignore patterns:

  ```ts
  import { defineConfig } from 'oxlint';
  import baseConfig from '../../oxlint.base.ts';

  export default defineConfig({
    extends: [baseConfig],
    plugins: ['typescript'],
    options: { typeAware: true, typeCheck: true }
  });
  ```

- Enable type-aware linting (`typeAware`, `typeCheck`) via `oxlint-tsgolint` in each demo's own
  config. These options are root-config-only, so they cannot live in the shared baseline.
- The shared baseline declares `plugins: []` so it never implicitly enables a plugin set that a
  given framework should not inherit.
- Fix lint findings. Disable a rule only with a comment explaining why, and prefer scoping the
  exception to the demo rather than weakening the shared baseline.

## Documentation: JSDoc

Demo code is read more than it is run. Document accordingly.

- **Every** exported function, class, method, and interface member has a JSDoc block.
- Non-exported helpers are documented too when they contain real logic.
- Each documented function includes:
  - `@param` for **every** parameter, describing meaning rather than restating the type.
  - `@returns` describing the value, or what has happened once the promise settles.
  - `@throws` for **every** error a caller can reasonably encounter, naming the error type.
- Document the interesting failure paths, not just the happy path: validation failures,
  authorization failures, and storage/transport failures.
- Interface members and configuration fields get a short description each.
- Explain **why**, not just what, when a decision is non-obvious: consistency trade-offs, security
  reasoning, or a workaround for a platform constraint. Link the relevant file when behaviour is
  split across tiers.
- Keep comments truthful. A stale comment is worse than no comment.

## Architecture: four tiers

Default to a four-tier separation, with dependencies pointing in one direction only:

```text
UI  →  API  →  application/domain  →  infrastructure
```

1. **UI** — presentation and user interaction. Talks to its own backend over HTTP; it never reaches
   a datastore directly.
2. **API** — HTTP routing, authentication/authorization middleware, request limits, and response
   shaping. Handlers stay thin enough to read as a description of the API surface.
3. **Application/domain** — use cases, validation, and business rules. Depends on a repository
   **port** (an interface), never on a concrete storage product.
4. **Infrastructure** — the adapter implementing that port (KV, D1, R2, Durable Objects), plus the
   Terraform that provisions it.

Supporting rules:

- Compose the tiers in one place (the application entry point) and inject the service into request
  handling. Route handlers must not construct repositories.
- Put validation in the domain layer so every transport enforces the same rules.
- Choose storage by the guarantees the demo needs, and document the trade-off:
  - KV for simple, read-heavy data that tolerates eventual consistency.
  - D1 for relational data, constraints, and transactions.
  - Durable Objects for strongly consistent, per-entity coordination.
- A demo may be small, but the seams must still be visible. Collapsing tiers teaches the wrong
  lesson.

## WebSockets and Durable Objects

Hold a WebSocket in a Durable Object, never in a plain Worker: a Worker isolate can be evicted and
the connection is then simply lost, because nothing durable is holding it. Accept the socket with
`ctx.acceptWebSocket()` (the Hibernation API) rather than `socket.accept()`, so an idle connection
stays open at the edge while the object is evicted and stops accruing charges.

**Forward the caller's upgrade request to the Durable Object.** Do not try to replace the upgrade
with an RPC method. Two independent constraints make RPC impossible, and both are runtime failures
rather than type errors:

- A `WebSocket` is not serializable, so returning a `101` response from an RPC method fails with
  `DataCloneError: Could not serialize object of type "WebSocket"`.
- The Hibernation API completes the protocol switch against the incoming request itself, so the
  request has to reach the object.

Every *other* call into the object should still be a typed RPC method. The upgrade is the
exception, not the pattern.

Because the upgrade travels as a request, the verified identity has to travel as a request header,
and that carries an obvious hazard — a client can send the same header. Handle it explicitly:

- **Delete any inbound copy of the identity header before setting the verified value.** Do this in
  one named function so the deletion and the assignment cannot be half-performed, and so there is a
  single place to test.
- Test that a smuggled header is ignored, at both the unit level (including a differently-cased
  spelling, since header names are case-insensitive) and in the Workers-runtime suite.
- Pin the identity to the socket with `serializeAttachment()` and read the author back from the
  attachment on every message. Never take an author from the frame; the wire protocol should have
  no author field at all, and the domain should reject a payload that adds one.
- State in a comment why the object may trust the header: it has no route of its own, so the only
  way to reach it is through a Worker that authenticated the caller first.

Anything the object needs after hibernation must live in its storage or in a socket attachment. An
instance field will be empty when the object is reconstructed, which is precisely when the value is
needed.

Other rules that follow from the transport:

- Put the upgrade route under the same path prefix the Access policies already cover, so it is
  gated by the same rule as every other API route rather than needing its own.
- Use `redirect: false` for that policy. A browser's `WebSocket` constructor cannot follow a
  redirect to a login page, so redirecting an unauthenticated upgrade surfaces as an unexplained
  connection failure instead of an authentication error.
- Persist a message before broadcasting it. Broadcasting first lets a client see a message that a
  later history replay would not contain.
- Answer a non-upgrade request to the socket route with `426 Upgrade Required`, not `400`. The
  request is well-formed and the resource exists; it is the protocol that is wrong.
- Share one module defining the frame types between the object and the browser, as a discriminated
  union, so a `switch` on the client is checked for exhaustiveness and adding a frame fails the
  build until the client handles it.

## Access control: Cloudflare Access

- Protect every administrative or privileged surface with **Cloudflare Access**. Do not hand-roll
  authentication.
- Defence in depth is required: Access gating at the edge is **not** sufficient on its own. Validate
  the Access JWT inside the application _and_ check the specific authorized identity. Every Access
  application in a team shares a JWKS, so a token minted for an unrelated application in the same
  team would otherwise be accepted.
- Keep public routes explicitly public via a bypass policy, and keep the path policy list as a
  single shared definition used by both local development and the deployed application.
- Local development must emulate Access rather than disabling it, so the local and deployed
  authorization paths stay identical.
- Never enable development-token bypass in a deployed build. Gate it on a build-time flag that is
  statically false in production.

## Cloudflare toolkit and CLIs

- **Never use Wrangler in this repository.** `cf` supersedes Wrangler and these demos exist to
  illustrate the current `cf`-based workflow. Do not add Wrangler commands, Wrangler dependencies,
  or embedded `wrangler.jsonc` files. If a platform corner case genuinely requires Wrangler or an
  embedded Wrangler configuration, flag it explicitly in the demo README and in the relevant family
  `AGENTS.md` so product teams can address the gap; do not silently introduce the exception.

Prefer existing, tested utilities over bespoke code.

- Use `@adrianhall/cloudflare-toolkit` for cross-cutting concerns rather than reimplementing them:
  - RFC 9457 problem-details errors and the matching error/not-found handlers.
  - Cloudflare Access middleware and its local development plugin.
  - Structured logging.
  - Defensive guards.
  - Test helpers for signing development JWTs.
- Use the toolkit's CLIs for deployment and cleanup work instead of ad-hoc scripting, including
  Terraform-output templating, type freshness, R2 bucket emptying, container cleanup, account
  inventory, and Cloudflare Access-control reconciliation. Family-specific deployment wiring lives
  in the relevant family `AGENTS.md`.
- When a demo does **not** use Terraform, use the toolkit's `cf-access-controls` command to install
  and remove its Cloudflare Access controls as part of `deploy` and `teardown`. Never leave Access
  policies/applications unmanaged just because the application framework deploys its own code.
- Use the Cloudflare CLI for platform operations (local dev, build, deploy, type generation,
  resource management).
- Return errors as RFC 9457 `application/problem+json`. Never leak stack traces from a deployed
  application.

### Shared Worker library

`@demos/worker-common` is the repository's shared Worker-tier library. Add it as
`"@demos/worker-common": "workspace:*"` in a demo that uses an exported concern, and prefer its
implementation over writing a demo-local version. Its unit tests own the reusable behaviour; a demo
keeps tests for its policy choices, routes, authorization, and end-to-end wiring.

- Use `createAccessMiddleware({ buildPolicies, enableDevTokens: import.meta.env.DEV })` for
  Cloudflare Access verification. Bind `ACCESS_AUD` from the Access application's Terraform output,
  thread that audience into every authenticating `PathPolicy`, and pass the same policy builder and
  committed local audience placeholder to `cloudflareAccessPlugin` in Vite. Do not reimplement
  audience lookup, middleware memoization, or fail-closed Access defaults locally.
- Use `currentIdentity()` or `currentIdentityEmail()` to derive the actor only from the Access
  middleware's verified identity. Do not accept an actor from a request parameter, body, or header.
- Use `createMeRouter()` for `/api/me`; pass its `middleware` option when that endpoint needs an
  additional authorization check such as `requireAdmin`.
- Use `jsonBodyLimit()` before parsing JSON and `readJsonBody()` to parse it. Do not replace their
  RFC 9457 error handling with local copies. The default body limit is 8 KiB; pass an explicit byte
  count only when the endpoint has a documented larger payload contract.
- Use `upgradeRequired(detail)` for an HTTP request made to a WebSocket-only endpoint.
- If a need is not covered by this package, first decide whether it belongs in
  `@adrianhall/cloudflare-toolkit`; when it is repository-specific and needed by multiple demos,
  add it to `packages/worker-common` with complete JSDoc and unit tests rather than duplicating it.

## Infrastructure lifecycle

Choose the least complex lifecycle owner that can provide all three required operations:

```text
pnpm start  → local development
pnpm deploy → deploy every resource the demo needs
pnpm teardown → remove every resource the demo created
```

- Terraform is **not** a requirement for every demo. Astro and vinext demos may use their native
  deployment pipelines when those pipelines can create and remove all required infrastructure.
- Use Terraform when the selected framework/deployment CLI cannot reliably provision and tear down
  the required infrastructure.
- A demo must have exactly one clear owner for each resource. Do not let Terraform and a framework
  deployment pipeline both manage the same application, binding, hostname, or Access resource.
- For non-Terraform demos, the framework pipeline owns application infrastructure, while
  `cf-access-controls` owns Cloudflare Access controls. Wire both into the demo's `deploy` and
  `teardown` scripts.

### Terraform-specific rules

When Terraform is the selected lifecycle owner:

- Terraform owns infrastructure; the deployment CLI owns application code and deploy-time bindings.
- Split Terraform by concern: providers/credentials, access control, one file per deployable unit,
  one file per shared resource, and outputs.
- Terraform reads the repository-root `.env`; do not introduce `TF_VAR_*` plumbing.
- Give every output a `description`, and keep outputs scalar.
- Force correct teardown ordering with explicit `depends_on` from the application resource to the
  resources it binds.
- Never commit Terraform state, generated outputs, or generated configuration.

## Testing

- Test each tier at the appropriate level: domain/validation and repository logic as unit tests, UI
  behaviour in a DOM environment, and the deployed surface in the real runtime.
- Integration tests must exercise authorization outcomes, not just the happy path.
- **Every integration-test project must specify a finite test timeout.** This prevents a blocked
  integration test from hanging CI or an agentic process indefinitely.
- Tests must pass offline and must not depend on live infrastructure.

## Definition of done

Before considering a demo change complete:

1. `pnpm check` passes.
2. `pnpm test` passes.
3. `pnpm start` works from a clean checkout with only the root `.env` configured.
4. `pnpm deploy` followed by `pnpm teardown` leaves the account clean.
5. New and changed code carries complete JSDoc.
6. The demo's `README.md` documents prerequisites, commands, and any trade-offs.
