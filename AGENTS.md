# Cloudflare Developer Platform Demos

## Mission

This monorepo contains complete, independently deployable demos of Cloudflare
Developer Platform capabilities.

When asked to implement a demo described by `docs/<scenario>.md`:

1. Read this file and the selected scenario brief before making changes.
2. Treat this file as the repository-wide contract. The scenario brief should
   contain only the demo's unique name, hostname, Cloudflare products, behavior,
   and explicit exceptions.
3. Derive ordinary implementation details from this file and current product
   documentation. Do not require the scenario brief to repeat shared standards.
4. Use only the products needed by the scenario. Do not add infrastructure or
   abstractions that do not help demonstrate the requested capability.
5. Implement the demo end to end, including infrastructure, source, tests,
   deployment scripts, teardown, and documentation.

If a scenario explicitly conflicts with this file, the scenario controls only
for that demo. Preserve all unrelated repository-wide requirements.

The Worker, custom domain, and Access application/policy are baseline resources
required by this repository. Scenario product lists name the additional products
being demonstrated and do not need to repeat these baseline resources.

`demos/url-shortener` is the canonical example demo: it follows every practice
in this file, including the sanctioned bootstrap-deployment exception, the
single-`wrangler.jsonc.tpl` local/production config generation pattern, the
Source Organization layout, the three-Vitest-project testing setup, and the
Public Access defense-in-depth pattern. When this file's guidance on a topic
is unclear, read the corresponding code in `demos/url-shortener` before
guessing.

## Demo Layout

Create each demo in `demos/<name>`, using a lowercase, hyphenated directory
name. Each demo MUST contain:

- `infra/`: Terraform configuration for every Cloudflare resource.
- `src/`: application source code.
- `tests/`: Workers-runtime integration tests. Unit and component/browser-
  behavior tests are colocated Vitest projects under `src/` — see Source
  Organization and Testing And Verification.
- `.env.example`: every required environment variable, with no real secrets.
- `package.json`: consistent `build`, `test`, `deploy`, and `teardown` scripts.
- `README.md`: the operator and developer guide, including architecture, local
  development, deployment, observability, troubleshooting, and teardown.
- `DEMO.md`: the presenter and user guide explaining the demo, the Cloudflare
  capabilities it showcases, and the complete demonstration workflow.

Keep demos independent. A user must be able to deploy or destroy one demo
without affecting another.

## Resource Ownership

Terraform and Wrangler have separate responsibilities:

- Terraform owns the Worker resource, Access resources, custom domain, and all
  product-specific supporting infrastructure.
- Use a tested and constrained Cloudflare provider v5 release. The current
  baseline is `~> 5.22.0`; update it only after validating the newer release.
- Wrangler owns Worker code versions and deployments. Terraform must not
  create, update, or promote the Worker's real deployments.
- Sanctioned exception: `cloudflare_workers_custom_domain` requires the Worker
  to already have at least one deployment, and Cloudflare rejects attaching a
  domain earlier with error `100124`. On a brand-new Worker, give Terraform a
  one-time, permanently inert placeholder deployment purely to satisfy that
  ordering, and never touch it again:

  ```hcl
  resource "cloudflare_worker_version" "bootstrap" {
    account_id         = local.cloudflare_account_id
    worker_id          = cloudflare_worker.demo.id
    main_module        = "index.js"
    compatibility_date = "<today's date>"

    modules = [{
      name         = "index.js"
      content_type = "application/javascript+module"
      content_base64 = base64encode(<<-JS
        export default {
          async fetch() {
            return new Response("Bootstrapping", { status: 503 });
          },
        };
      JS
      )
    }]

    lifecycle {
      ignore_changes = all
    }
  }

  resource "cloudflare_workers_deployment" "bootstrap" {
    account_id  = local.cloudflare_account_id
    script_name = cloudflare_worker.demo.name
    strategy    = "percentage"

    versions = [{
      version_id = cloudflare_worker_version.bootstrap.id
      percentage = 100
    }]

    lifecycle {
      ignore_changes = all
    }
  }

  resource "cloudflare_workers_custom_domain" "demo" {
    # ... hostname, service, zone_id ...
    depends_on = [cloudflare_workers_deployment.bootstrap]
  }
  ```

  Deployments are immutable historical records: every later `wrangler deploy`
  creates its own new version and deployment that Terraform never sees or
  reverts, so `ignore_changes = all` is safe permanently, not only on the
  first apply. No `package.json` script changes are needed for this — it is
  entirely a Terraform-side fix and is idempotent across every `npm run
  deploy`.
- Use `@adrianhall/cloudflare-scripts` from a pinned GitHub release to generate
  `wrangler.jsonc` from Terraform outputs, generate binding types, and perform
  cleanup that Terraform cannot perform.
- Commit exactly one Wrangler configuration template, `wrangler.jsonc.tpl`,
  with a `{{placeholder}}` marker for every Terraform-sourced value. Do not
  also commit a static `wrangler.local.jsonc`: that two-file split was tried
  first and abandoned because running Vite against an alternate config file
  caused real problems (see `docs/DECISIONS.md`).
- Add a small `scripts/generate-local-wrangler.js` that fills the same
  `{{placeholder}}` markers with hardcoded local-development values and writes
  the result to the ordinary gitignored `wrangler.jsonc` — the exact filename
  `generate-wrangler` (`@adrianhall/cloudflare-scripts`) also writes from real
  Terraform outputs. The script must do nothing but exit `0` if `wrangler.jsonc`
  already exists, so it never overwrites a real Terraform-generated config, and
  it must throw if the template contains a `{{marker}}` with no configured
  local value, so a newly added Terraform output can never silently leak an
  unsubstituted placeholder into a local build. Wire it into `prebuild`,
  `prestart`, and `precheck:types` (each as `run-s generate:wrangler:local
  generate:types`) so `vite dev`, `vite build`, and `tsc --noEmit` all work
  from a clean checkout with no Terraform state.
- `npm run deploy`'s `predeploy:worker` hook must always regenerate the real
  config afterward with `generate-wrangler -f --terraform infra` — the `-f`
  matters, or a once-generated local placeholder `wrangler.jsonc` would never
  get overwritten by a real deploy.
- Because there is only ever one canonical `wrangler.jsonc` on disk at a time,
  the Cloudflare Vite plugin's default config-file discovery is fine. Still
  point `@cloudflare/vitest-pool-workers` at it explicitly via a `configPath`
  resolved from `import.meta.dirname` (not the process's working directory),
  so integration tests behave the same regardless of invocation directory.
- Put local-only overrides that are not Terraform outputs (for example, a
  Worker `ENVIRONMENT` value distinct from production) in a committed
  `.dev.vars` — commit it only when it holds no secrets, and say so in a
  comment at the top of the file.
- Run product migrations, including D1 migrations, through Wrangler when needed. D1 migration
  scripts MUST set `CI=1` to suppress Wrangler's interactive confirmation, target the configured
  database binding name rather than a Terraform output or database name, and always state the
  target location explicitly. Use separate atomic scripts named `db:migrate:remote` and
  `db:migrate:local`, for example `CI=1 wrangler d1 migrations apply DB --remote` for deployment
  and `CI=1 wrangler d1 migrations apply DB --local` for local development. Never omit either
  `--remote` or `--local`.
- The generated `wrangler.jsonc` MUST NOT duplicate ownership of settings
  managed by Terraform.
- `npm run deploy` and `npm run teardown` MUST orchestrate the entire lifecycle.
  A successful teardown leaves no named or billable demo resources behind.
  Compose each from small, independently runnable `package.json` scripts (for
  example `infra:init`, `infra:apply`, `infra:generate-wrangler`) chained with
  `npm-run-all2`'s `run-s`, plus inline shell command substitution reading
  Terraform outputs (`terraform -chdir=infra output -raw <name>`) where a step
  needs a dynamic value, such as a generated Worker name for a `wrangler deploy
  --config` path. Only add a custom Node script under `scripts/` when the task
  cannot be expressed as an atomic package.json script — reading structured
  Terraform JSON, writing a generated file that isn't `wrangler.jsonc`, or
  multi-condition branching. Never write a custom script whose only job is to
  chain other commands together or to re-implement a check Terraform or
  Wrangler already performs (a missing `.env` key or file, for example,
  already fails clearly from `terraform plan`/`apply` through the `dotenv`
  provider without a hand-written pre-check).
- Use the Terraform `dotenv` provider (`jrhouston/dotenv ~> 1.0`) to read
  configuration from `../.env`. Declare locals from `data.dotenv.config.env`
  instead of separate variables, mark secret-derived values sensitive, and
  protect Terraform state. Never require operators to set `TF_VAR_*` environment
  variables; Terraform reads directly from `.env`.
- Prefer a Vite build-time define (an `import.meta.env.VITE_*` variable set
  inline on the build command from a Terraform output) over a generated
  TypeScript source file when a Worker needs a build-time-only constant, such
  as a Cloudflare Access application audience tag that must be static at
  module scope. Reserve generated Worker bindings (`wrangler.jsonc` `vars`) for
  values the Worker legitimately needs to read from `env` at request time.

## Public Access

Every custom hostname MUST have a Cloudflare Access self-hosted application.
Requests matching an Access application are denied when no policy applies, so a
normal public demo MUST attach an explicit reusable bypass policy:

```hcl
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22.0"
    }
  }
}

resource "cloudflare_zero_trust_access_policy" "public_demo" {
  account_id = var.cloudflare_account_id
  name       = "${var.demo_name} public access"
  decision   = "bypass"

  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "demo" {
  account_id = var.cloudflare_account_id
  name       = var.demo_name
  domain     = "${var.demo_name}.${var.demo_domain}"
  type       = "self_hosted"

  policies = [{
    id         = cloudflare_zero_trust_access_policy.public_demo.id
    precedence = 1
  }]
}
```

A bypass policy does not issue an Access identity JWT. Do not apply
`cloudflareAccess()` middleware to bypassed traffic.

If the scenario explicitly demonstrates Cloudflare Access or the Worker needs a
validated user identity, replace the bypass policy for that traffic with an allow
policy that requires authentication through a configured identity provider. A
demo mixing public and authenticated routes MUST define a separate,
more-specific Access application for the protected hostname or path, scoped
with explicit `destinations` entries for every protected path prefix on the
same hostname (for example `/admin*`, `/api/links*`, `/api/me*`) rather than a
narrower `domain` alone. Access routes each request to the most-specific
matching application across every application defined on a hostname, so the
public application's bypass policy still covers everything the more specific
application's `destinations` don't list — no third "everything else" policy is
needed.

Use `cloudflareAccess()` in the Worker to protect API/data routes, and prefer
setting the exact application `audience`. When a demo deliberately skips
`audience` (every Access application on a team shares the same JWKS, so
without it any valid token from a *different* application in the same team is
also accepted here — cross-application token replay), compensate with explicit
application-level identity verification instead of relying on
`cloudflareAccess()` alone: a small Hono middleware that compares the verified
identity's email against an expected-identity Worker variable (threaded
through from a Terraform output, the same way `admin_email` is) and returns
`403` otherwise. Apply it to every management route, not only a "whoami"
endpoint used to surface the identity to the browser.

A page route that only Cloudflare Access needs to gate (an admin SPA route, for
example) does not need its own Worker route or a `wrangler.jsonc`
`run_worker_first` entry: Access enforcement happens at the edge before the
request reaches the Worker or the static-assets layer at all, so the page can
be served directly by the `ASSETS` binding's `single-page-application`
fallback, exactly like an unprotected route. Reserve `run_worker_first` for
paths the Worker's own code must actually inspect — API routes, redirects,
anything reading a binding — not for pages Access already fully gates; routing
a page through the Worker only to have no handler for it is a self-inflicted
`404`.

When a Vite-based demo uses `cloudflareAccess()`, it MUST also use
`cloudflareAccessPlugin()` from `@adrianhall/cloudflare-toolkit/vite` for local
development. The plugin emulates the Access edge locally; it is not part of
production authentication. Configure it before `cloudflare()` in `vite.config.ts`
and pass the same path-policy array to the Vite plugin and Worker middleware.
Give every distinct path prefix its own explicit policy entry — including page
routes that only the real Access application gates in production, since the
Vite plugin intercepts every request regardless of `run_worker_first` — rather
than relying solely on `defaultAction`, so the array documents the demo's full
access model at a glance and local dev matches production. Pass `users`
(selectable dev identities matching `.env.example`'s defaults, such as the
configured administrator email) so local sign-in is a single click instead of
typing an email every time. Enable development tokens only behind a
build-time development check, such as `import.meta.env.DEV`; never enable them
unconditionally in a deployed Worker. Tests should use helpers from
`@adrianhall/cloudflare-toolkit/testing`, not the Vite plugin.

Give any Access-gated browser UI a visible, unconditionally rendered control
that navigates to `/cdn-cgi/access/logout` — Cloudflare Access's real logout
endpoint, emulated identically by `cloudflareAccessPlugin` locally. Render it
even while the current identity is unauthorized: signing in as the wrong
identity during local development otherwise has no recovery besides clearing
cookies by hand.

## Runtime And Packages

- Use Node.js 24 or newer, npm 11 or newer, and TypeScript `^6.0.3`.
- Use Hono for Worker APIs unless the demonstrated capability requires a
  different interface.
- Deploy static frontend assets and the API as one Worker unless the scenario
  requires a different architecture.
- Generate Worker binding types from `wrangler.jsonc`; never hand-maintain the
  binding interface.
- Set a current compatibility date on new Workers.
- Enable `nodejs_compat` only when application dependencies require Node APIs.

Use `@adrianhall/cloudflare-toolkit` where applicable for:

- Structured logging and request-scoped Hono logging via `cloudflareLogger()`.
- RFC 9457 Problem Details errors and Hono error handling.
- Defensive guards and test helpers.
- Access JWT validation only for traffic protected by Access. Pair
  `cloudflareAccess()` with `cloudflareAccessPlugin()` in Vite-based demos.

Use `@adrianhall/cloudflare-scripts` where applicable for:

- Generating `wrangler.jsonc` from Terraform outputs.
- Generating Wrangler binding types.
- Emptying R2 buckets before destruction.
- Removing Container applications and images before destruction.
- Deployment and teardown orchestration.

## Source Organization

Split source by concern instead of collecting Worker logic into one file:

- `src/worker/index.ts`: routing only — mount middleware and sub-routers; no
  handler bodies live here.
- `src/worker/bindings.ts`: the `AppBindings`/`AppVariables` Hono generic
  types, the single source of truth every route and middleware file imports
  for `c.env`/`c.get`/`c.set` typing.
- `src/worker/middleware/`: one file per cross-cutting concern (Access,
  request-body limits, defense-in-depth identity checks), each with its own
  colocated `*.test.ts`.
- `src/worker/routes/`: one Hono sub-router per resource, mounted by
  `index.ts`.
- `src/worker/<domain>/`: domain logic — a repository, input validation, and
  types as separate files — imported by `routes/`, not inlined into a route
  handler.
- `src/client/`: `main.ts` (bootstrap only), `App.vue`, `views/` (one file per
  routed page), `stores/` (one Pinia store per concern).
- A module such as `src/access-policies.ts` holding the shared Access
  path-policy array imported by both the Worker middleware and
  `vite.config.ts` — see Public Access.

Colocate a unit test next to the file it tests as `<name>.test.ts`. Keep
Workers-runtime integration tests separate under `tests/integration/` — see
Testing And Verification.

## Browser Applications

Demos with a browser UI use:

- Vue 3 and TypeScript.
- Vite with the Cloudflare Vite plugin. When the Worker uses
  `cloudflareAccess()`, also configure the toolkit's development-only Access Vite
  plugin as specified under Public Access.
- Vuetify with the shared Cloudflare-inspired design language.
- Use Feather Icons where an interface requires an icon. Do not rely on an
  unconfigured component-library icon set or hand-drawn SVG icons.
- Pinia for shared client state.
- Vue Router for navigation.

Do not add the browser stack to API-only, scheduled, queue, email, or
infrastructure-only demos.

Build focused demonstration interfaces rather than generic dashboards. The
primary workflow from the scenario MUST be obvious on desktop and mobile and
must meet WCAG 2.2 AA expectations.

## Documentation

These repositories are demonstrations, so documenting what is actually
implemented is part of the deliverable. Every demo MUST provide all three
documentation layers:

1. TypeScript API documentation. Add JSDoc to every authored TypeScript
   interface, type alias, enum, class, function, and method, including internal
   declarations. Document parameters, return values, thrown errors, side
   effects, and non-obvious constraints where applicable. Keep JSDoc synchronized
   with the implementation; do not document planned or unimplemented behavior.
2. `README.md`. Provide a solid operator and developer guide with prerequisites,
   architecture, environment configuration, local development, testing,
   observability, exact deployment steps, verification, troubleshooting, and
   exact teardown steps. A new operator should be able to deploy and completely
   remove the demo using this document alone.
3. `DEMO.md`. Explain the demo's purpose, what Cloudflare products and
   capabilities it showcases, any demonstration prerequisites, the step-by-step
   presentation flow, expected results, and where to observe relevant logs,
   traces, metrics, or state.

Internal code comments are encouraged when behavior or a design decision is
non-obvious. Comments should explain why the code exists, important tradeoffs,
platform constraints, or surprising behavior rather than restating the code.
Remove stale comments whenever implementation behavior changes.

## Testing And Verification

- Use Vitest projects to organize tests, one `vitest.config.ts` per category,
  listed from a root `vitest.config.ts`'s `test.projects`. Do not use
  Playwright or any other real-browser tool.
  - `src/worker/vitest.config.ts` (`environment: "node"`, `name: "worker"`):
    fast unit tests for pure domain logic, validation, and middleware that
    don't need real bindings.
  - `src/client/vitest.config.ts` (`environment: "jsdom"`, `name: "client"`,
    `@vitejs/plugin-vue`): component and browser-behavior tests using
    `@vue/test-utils` and `@pinia/testing`.
  - `tests/integration/vitest.config.ts` (`name: "integration"`,
    `@cloudflare/vitest-pool-workers`, `configPath` pointed at the generated
    `wrangler.jsonc`): the Worker running in real `workerd` against its
    actual bindings (or Workers test equivalents).
- Colocate each unit/component test as `<name>.test.ts` beside the file it
  tests; keep integration tests separate under `tests/integration/` — see
  Source Organization.
- Configure `@vitest/coverage-istanbul` and add a `test:coverage` script.
  Treat any uncovered authored source as a gap to close, not an acceptable
  baseline.
- Unit-test domain behavior and error paths.
- Integration-test the primary API workflow using actual configured bindings
  or their Workers test equivalents, including Access enforcement (both
  unauthenticated and wrong-identity requests) for every protected path, not
  only the happy path.
- Test the complete primary workflow described in the scenario.
- Test teardown helpers that contain application logic.
- Run formatting, linting, type checking, tests, and the production build.
- Run `terraform fmt -check` and `terraform validate` in `infra`.
- Do not run `terraform apply`, deploy, or destroy real resources unless the
  user explicitly requests it and provides the required environment.

## Deployment

Deployment of one demo must be:

1. `cd demos/<name>`.
2. Copy `.env.example` to `.env` and fill in operator-provided values.
3. Run `npm run deploy`.

`npm run deploy` MUST provision infrastructure, generate Wrangler configuration
and types, run migrations, build, and deploy. `npm run teardown` MUST perform
prerequisite cleanup and run `terraform destroy`.

All demos require a custom domain in an active Cloudflare zone. The hostname
must not have a conflicting CNAME. Use the exact hostname from the scenario;
when the scenario supplies a full hostname, split it into `DEMO_NAME` and
`DEMO_DOMAIN` only if that representation is valid for the zone.

Every `.env.example` starts with the baseline permissions and adds only those
required by the demonstrated products:

```ini
# Baseline API token permissions:
# - Account: Workers Scripts - Edit
# - Account: Access: Apps and Policies - Edit
# Add only the permissions required by the products demonstrated.
# Logs and analytics read access is operational, not required for deployment.
CLOUDFLARE_API_TOKEN="<from-dashboard>"
CLOUDFLARE_ACCOUNT_ID="<from-dashboard>"
CLOUDFLARE_ZONE_ID="<from-dashboard>"
DEMO_DOMAIN="cfapps.uk"
DEMO_NAME="this-demo"
```

The example env file is stored in [`.env.example`](./.env.example).  Only add to
this file if it is explicitly required for infrastructure deployment of the demo
app.

The operator owns API-token creation, rotation, and revocation. Never create or
commit a token for a demo.

## Observability And Security

- Enable Workers Logs and automatic tracing with explicit sampling settings.
- Emit structured, correlated logs that make the demonstrated backend activity
  visible. Call `cloudflareLogger()` with no options and let it resolve level
  and transport from the Worker's `ENVIRONMENT` binding automatically. Do not
  add a custom `LOG_LEVEL` variable or a wrapper middleware around it —
  configurable log verbosity was tried and abandoned as unnecessary complexity
  for a demo (see `docs/DECISIONS.md`).
- A log statement placed after an early-return guard (an authorization check,
  a validation guard) never executes when that guard rejects the request
  first. Place logging after the guard it should reflect, not before it, when
  troubleshooting a selectively reached code path.
- Upload source maps for useful production stack traces.
- Never log secrets, credentials, Access tokens, authorization headers, or
  unnecessary personal data.
- Never hard-code secrets in source, Terraform, `wrangler.jsonc`, or committed
  environment files.
- Use Wrangler secrets or an appropriate Cloudflare secret binding for runtime
  secrets.
- If Terraform must pass a secret to a resource, use sensitive variables and
  secure the state backend.
- Validate all untrusted input and reject unsafe URLs, identifiers, and payloads
  before writing data or generating responses.
- Prefer bindings over calls to Cloudflare's REST API from inside a Worker.
- Await, return, or explicitly schedule every promise. Do not keep request state
  in module-level mutable variables.

## Agent Skills

Load skills before doing the work they cover:

- `cloudflare`: every demo.
- `cloudflare-one`: Access applications and policies.
- `workers-best-practices`: Worker code and configuration.
- `wrangler`: Wrangler commands and configuration.
- `cloudflare-toolkit`: use of `@adrianhall/cloudflare-toolkit`.
- `durable-objects`: Durable Object demos.
- `agents-sdk`: agents, chat, MCP, and scheduled-agent demos.
- `sandbox-sdk`: untrusted code execution.
- `cloudflare-email-service`: email sending or routing.
- `turnstile-spin`: Turnstile integration.
- `web-perf`: performance validation for browser demos.

Skills do not replace current documentation. Retrieve current Cloudflare docs,
the pinned Terraform provider schema, Workers types, and Wrangler schema before
relying on fields, limits, APIs, or command options.

## Completion Criteria

A demo is complete only when:

- Its scenario's primary workflow is implemented and tested.
- Terraform accounts for every provisioned resource.
- Deployment and teardown are single commands and are documented.
- The Worker, generated configuration, and bindings agree.
- Public or authenticated Access behavior matches the scenario.
- Logs and traces expose the activity the scenario asks the presenter to show.
- JSDoc covers all authored TypeScript declarations and describes implemented
  behavior accurately.
- `README.md` contains complete, tested deployment and teardown instructions.
- `DEMO.md` explains the showcased capabilities and a reproducible demo flow.
- Formatting, linting, type checking, tests, build, and Terraform validation
  pass.
- No secrets or generated local configuration are committed.

## References

### Cloudflare

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers infrastructure as code](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers traces](https://developers.cloudflare.com/workers/observability/traces/)
- [Workers source maps](https://developers.cloudflare.com/workers/observability/source-maps/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Manage reusable Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Cloudflare Terraform provider](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs)
- [`cloudflare_worker` resource](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/worker)
- [`cloudflare_workers_custom_domain` resource](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_custom_domain)
- [`cloudflare_worker_version` resource](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/worker_version)
- [`cloudflare_workers_deployment` resource](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_deployment)
- [`cloudflare_zero_trust_access_application` resource](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_access_application)
- [`cloudflare_zero_trust_access_policy` resource](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_access_policy)
- [Terraform `dotenv` provider](https://registry.terraform.io/providers/jrhouston/dotenv/latest/docs/data-sources/dotenv)

### Application Libraries

- [`@adrianhall/cloudflare-toolkit`](https://adrianhall.github.io/cloudflare-toolkit/)
- [`@adrianhall/cloudflare-scripts`](https://github.com/adrianhall/cloudflare-scripts)
- [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
- [Hono](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Vue 3](https://vuejs.org/guide/introduction.html)
- [Vite](https://vite.dev/guide/)
- [Vuetify](https://vuetifyjs.com/en/getting-started/installation/)
- [Pinia](https://pinia.vuejs.org/)
- [Vue Router](https://router.vuejs.org/)
- [Terraform](https://developer.hashicorp.com/terraform/docs)
