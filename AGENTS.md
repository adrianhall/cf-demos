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

## Demo Layout

Create each demo in `demos/<name>`, using a lowercase, hyphenated directory
name. Each demo MUST contain:

- `infra/`: Terraform configuration for every Cloudflare resource.
- `src/`: application source code.
- `tests/`: unit, Workers-runtime integration, and browser tests as applicable.
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
- Wrangler owns Worker code versions and deployments. Never also manage Worker
  versions or deployments in Terraform.
- Use `@adrianhall/cloudflare-scripts` from a pinned GitHub release to generate
  `wrangler.jsonc` from Terraform outputs, generate binding types, and perform
  cleanup that Terraform cannot perform.
- Commit a Wrangler configuration template, not generated production
  configuration. Provide a deterministic no-cloud generation path with local
  placeholder binding identifiers so formatting, type checking, tests, and local
  builds work from a clean checkout. Production deployment MUST regenerate the
  configuration from Terraform outputs.
- Run product migrations, including D1 migrations, through Wrangler when needed.
- The generated `wrangler.jsonc` MUST NOT duplicate ownership of settings
  managed by Terraform.
- `npm run deploy` and `npm run teardown` MUST orchestrate the entire lifecycle.
  A successful teardown leaves no named or billable demo resources behind.

Using the Terraform `dotenv` provider to read `.env` is acceptable. Declare the
provider explicitly, do not commit `.env`, mark secret-derived values sensitive,
and protect Terraform state.

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
policy that requires authentication through a configured identity provider.
Use `cloudflareAccess()` in the Worker and validate the exact application
audience. A demo mixing public and authenticated routes MUST define a separate,
more-specific Access application for the protected hostname or path.

When a Vite-based demo uses `cloudflareAccess()`, it MUST also use
`cloudflareAccessPlugin()` from `@adrianhall/cloudflare-toolkit/vite` for local
development. The plugin emulates the Access edge locally; it is not part of
production authentication. Configure it before `cloudflare()` in `vite.config.ts`
and pass the same path-policy definitions to the Vite plugin and Worker
middleware. Enable development tokens only behind a build-time development
check, such as `import.meta.env.DEV`; never enable them unconditionally in a
deployed Worker. Tests should use helpers from
`@adrianhall/cloudflare-toolkit/testing`, not the Vite plugin.

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

## Browser Applications

Demos with a browser UI use:

- Vue 3 and TypeScript.
- Vite with the Cloudflare Vite plugin. When the Worker uses
  `cloudflareAccess()`, also configure the toolkit's development-only Access Vite
  plugin as specified under Public Access.
- Vuetify with the shared Cloudflare-inspired design language.
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

- Run Worker tests in `workerd` with the Cloudflare Vitest integration.
- Unit-test domain behavior and error paths.
- Integration-test the primary API workflow using actual configured bindings or
  their Workers test equivalents.
- Add browser tests when browser behavior is central to the demonstration.
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
  visible. Use `cloudflareLogger()` where appropriate.
- Upload source maps for useful production stack traces.
- Make debug and trace verbosity configurable with a Worker variable.
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
