# Cloudflare Developer Platform Demos

This monorepo contains demo applications that showcase Cloudflare Developer
Platform capabilities. Each demo is located in `demos/<name>` and contains:

1. Terraform configuration in `infra` that provisions and destroys the Worker
   resource, Cloudflare Access resources, the custom domain, and all
   product-specific infrastructure.
2. Application source code in `src`.
3. Unit, integration, and browser tests in `tests`, as appropriate for the demo.
4. An `.env.example` that documents every required environment variable without
   containing secrets.

## Resource Ownership

Terraform and Wrangler have separate responsibilities:

- Terraform, using a tested and constrained Cloudflare provider v5 release, owns
  the Worker resource and all supporting Cloudflare resources.
- Wrangler owns Worker code versions and deployments. Do not also manage Worker
  versions or deployments in Terraform.
- `@adrianhall/cloudflare-scripts`, installed from a pinned GitHub release,
  generates `wrangler.jsonc` from Terraform outputs and performs any cleanup
  required before `terraform destroy`.
- Wrangler runs product-specific migrations, such as D1 migrations, when
  required.
- The demo's `deploy` and `teardown` scripts MUST orchestrate the complete
  lifecycle. A successful teardown MUST leave no billable or named demo
  resources behind.

## Public Access

Every custom hostname MUST be registered as a Cloudflare Access self-hosted
application. Requests matching an Access application are denied when they do not
match an applicable policy, so every demo **MUST** attach an explicit reusable
bypass policy that makes the demo publicly accessible.

Pin the provider to the tested minor release and use its v5 object syntax.
Update the constraint deliberately after validating the demo against a newer
release.

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

A bypass decision skips Access authentication and does not issue an Access
identity JWT. Therefore, do not apply `cloudflareAccess` authentication
middleware to a hostname or path covered by the public bypass policy. A demo
that also needs authenticated routes MUST define a separate, more-specific
Access application for the protected hostname or path, attach non-bypass
policies to it, and validate that application's audience.

Exception: If a demonstration is explicitly demonstrating "Cloudflare Access",
then using `cloudflareAccess()` middleware from the cloudflare-toolkit and uses
an alternate `cloudflare_zero_trust_access_policy` is required.  The zero trust
access policy should use "allow" for "everyone" using "any known IdP".

## Shared Packages

Every demo uses `@adrianhall/cloudflare-toolkit` where applicable:

- Structured logging suitable for Workers Logs.
- Hono request logging middleware.
- RFC 9457 Problem Details errors and Hono error handling.
- Defensive guards and test helpers.
- Cloudflare Access authentication only for routes that are actually protected
  by Access.

Every demo uses `@adrianhall/cloudflare-scripts`, installed from a pinned GitHub
release, for applicable lifecycle tasks:

- Generate `wrangler.jsonc` from Terraform outputs.
- Generate Wrangler binding types.
- Empty R2 buckets before destruction.
- Remove Container applications and images before destruction.
- Support deployment and teardown orchestration.

## Application Stack

All demos use TypeScript `^6.0.3`. Demos with a browser UI use the following stack:

- Vue 3.
- Vite with the Cloudflare Vite plugin.
- Vuetify with a shared Cloudflare-inspired design language.
- Pinia.
- Vue Router.

Most demos are API-driven and use Hono for the Worker API. Static frontend
assets and the API SHOULD be deployed together as one Worker unless the
demonstrated capability requires a different architecture.

Tests SHOULD run Worker code in the Workers runtime using the Cloudflare Vitest
integration. Browser-facing behavior SHOULD be covered with browser tests when
it is central to the demo. 

## Agent Skills

Add the following available skills to the coding-agent environment and load them
when relevant:

- `cloudflare`: required for all demos and current Cloudflare platform guidance.
- `cloudflare-one`: required when creating or changing Access applications and
  policies.
- `workers-best-practices`: required when writing or reviewing Worker code and
  configuration.
- `wrangler`: required before running or documenting Wrangler commands.
- `cloudflare-toolkit`: required when using `@adrianhall/cloudflare-toolkit`.
- `durable-objects`: required for demos using Durable Objects.
- `agents-sdk`: required for stateful agents, chat, MCP, or scheduled agent
  demos.
- `sandbox-sdk`: required for demos that execute untrusted code.
- `cloudflare-email-service`: required for email sending or routing demos.
- `turnstile-spin`: required for demos protected by Turnstile.
- `web-perf`: use for performance and Core Web Vitals validation of user-facing
  demos.

Skills do not replace current documentation. Retrieve the relevant Cloudflare
documentation and the schema for the pinned provider version before relying on
API fields, Terraform resource shapes, limits, or Wrangler options.

## Deployment

Deployment of one demo consists of:

1. `cd demos/<name>`.
2. Obtain an operator-provided, least-privilege Cloudflare API token scoped to
   the target account and zone. Token creation, rotation, and revocation remain
   operator responsibilities outside the demo lifecycle.
3. Copy `.env.example` to `.env` and provide the required values.
4. Run `npm run deploy` to provision infrastructure, generate configuration and
   types, run migrations, build the application, and deploy the Worker.

Each demo MUST also provide `npm run teardown` to clean up resources and run
`terraform destroy`.

All demos require a custom domain in an active Cloudflare zone. Custom Domains
create the necessary DNS record and TLS certificate; the hostname must not
already have a conflicting CNAME record.

An `.env.example` might contain:

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

This configuration creates the Worker resource and supporting infrastructure
with Terraform, then deploys code and assets with Wrangler to
`https://this-demo.cfapps.uk`. The package scripts are responsible for mapping
`.env` values to Terraform variables and Wrangler configuration.

A good Terraform resource provider is [`dotenv`](https://registry.terraform.io/providers/jrhouston/dotenv/latest/docs/data-sources/dotenv), which loads a `.env` file and can turn it into
Terraform local variables.

## Observability And Security

- Enable Workers Logs and automatic tracing for every Worker, with explicit
  sampling settings appropriate to the demo.
- Emit structured logs with request correlation and enough detail to demonstrate
  backend activity.  Use `cloudflareLogger()` middleware where appropriate.
- Upload source maps so production stack traces resolve to the TypeScript
  source.
- Never log secrets, credentials, Access tokens, authorization headers, or
  unnecessary personal data.
- Debug and trace verbosity MUST be configurable via a workers variable.
- Never hard-code secrets in source, Terraform configuration, `wrangler.jsonc`,
  or committed `.env` files. When Terraform must supply a secret to a managed
  resource, use sensitive input variables and secure the Terraform state. Use
  Wrangler secrets or an appropriate Cloudflare secret binding for Worker
  runtime secrets.
- Set a current compatibility date for new Workers and enable `nodejs_compat`
  when dependencies require Node.js APIs.
- Generate Worker binding types from `wrangler.jsonc`; do not maintain binding
  interfaces by hand.

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

### Application Libraries

- [`@adrianhall/cloudflare-toolkit`](https://adrianhall.github.io/cloudflare-toolkit/)
- [`@adrianhall/cloudflare-scripts`](https://github.com/adrianhall/cloudflare-scripts)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [Hono](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Vue 3](https://vuejs.org/guide/introduction.html)
- [Vite](https://vite.dev/guide/)
- [Vuetify](https://vuetifyjs.com/en/getting-started/installation/)
- [Pinia](https://pinia.vuejs.org/)
- [Vue Router](https://router.vuejs.org/)
- [Terraform](https://developer.hashicorp.com/terraform/docs)
