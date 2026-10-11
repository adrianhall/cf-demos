# `cf` + Terraform demo rules

These rules supplement the repository-wide [demo rules](../AGENTS.md) for applications in
`cf-terraform-demos/`. They document the `cf` build-output and Terraform ownership model used by
these demos.

## Deployment control plane

- Use Cloudflare’s `cf` CLI and Cloudflare Vite plugin for Worker code and deploy-time bindings.
- Use Terraform for infrastructure that `cf` cannot own with a complete lifecycle: Worker
  registration, dedicated bindings, custom hostnames, DNS-related resources, and Cloudflare Access
  applications/policies when Access is Terraform-owned.
- Terraform and `cf` must have exactly one owner per resource. Terraform must not upload Worker
  application code, and `cf` must not recreate Terraform-managed infrastructure.
- The canonical lifecycle is:

  ```text
  terraform apply → write Terraform outputs → cf/Vite build → cf deploy --prebuilt
  cf workers delete → terraform destroy
  ```

- `cf` deployments are not a complete infrastructure teardown mechanism. A Terraform-backed demo
  must delete the deployed Worker before `terraform destroy`, so deploy-managed bindings no longer
  prevent Terraform resources from being deleted.

## `cloudflare.config.ts`

- Keep one typed `cloudflare.config.ts` as the `cf` Worker configuration source of truth.
- Use `defineWorker()` and `defineConfig()` from `cf/config`.
- Resolve production resource IDs through `@adrianhall/cloudflare-toolkit/vite`'s
  `requireTerraformOutputs`, reading the ignored `infra/outputs.json` generated after Terraform
  apply.
- Use committed local placeholder outputs for development and tests. Local commands must not read
  live Terraform state or require an untracked `.dev.vars` file.
- Generate platform types with `cf workers types --mode development` as part of `check:types`.
  Include the generated `.cloudflare/types/index.d.ts` in `tsconfig.json` and ignore `.cloudflare/`.
- The Worker configuration must explicitly set compatibility date, preview/Workers Dev behavior,
  observability settings, and environment bindings. Keep the same binding names in Terraform
  outputs, configuration, generated types, and application code.

## Terraform layout and ownership

- Split Terraform by concern:
  - `providers.tf`: required providers, repository-root `.env` data source, provider, and shared
    locals.
  - `access.tf`: Cloudflare Access policies and applications.
  - One Worker file per deployable Worker, including its dedicated binding resources and custom
    hostname.
  - `outputs.tf`: documented scalar outputs consumed by `cloudflare.config.ts`.
- Terraform reads the repository-root `.env` through the dotenv provider. Do not add `TF_VAR_*`
  plumbing or a second per-demo environment file.
- Use current Cloudflare Terraform provider v5 resource schemas. Do not use legacy
  `cloudflare_workers_script` resources for application deployment.
- Add explicit `depends_on` from a Worker registration to every Terraform-managed binding resource
  it uses. The binding is attached by `cf`, so Terraform cannot infer that dependency; the explicit
  edge ensures safe reverse-order destruction.
- Include a stable bootstrap Worker version/deployment before attaching a custom hostname, because
  Cloudflare rejects a custom domain for a Worker that has never been deployed. Mark bootstrap
  resources with `ignore_changes = all` so later `cf` deployments do not produce Terraform drift.
- Every output needs a description and must remain scalar. Never commit Terraform state,
  `infra/outputs.json`, or generated deployment configuration.

## Access ownership

- If Access resources are declared in Terraform, do not also reconcile those same resources with
  `cf-access-policy`.
- Keep public bypass applications and administrative applications distinct and path-specific.
- The Worker must still validate Access JWTs and the exact authorized identity as defense in depth;
  an edge Access application alone is not sufficient.

## Package scripts

A typical Terraform-backed `cf` demo exposes these individually runnable steps:

```json
{
  "scripts": {
    "start": "cf dev",
    "generate:types": "cf workers types --mode development",
    "deploy:infra": "run-s deploy:infra:init deploy:infra:apply",
    "deploy:worker": "run-s deploy:worker:build deploy:worker:upload",
    "deploy:worker:build": "vite build --mode production",
    "deploy:worker:upload": "cf deploy --prebuilt",
    "teardown:worker": "cf workers delete <worker-name> --force || true",
    "teardown:infra": "terraform -chdir=infra destroy -auto-approve"
  }
}
```

- `cf d1 migrations apply` is currently flaky immediately after Terraform creates a D1 database
  (observed: a 403 / code 7403 on the D1 query endpoint even though the same credentials can list
  and query the database moments later). This is under review with the product team. If a remote
  migration fails right after provisioning, wait 30 seconds and retry only the migration step (for
  example `pnpm migrate:remote`, then continue with `pnpm deploy:worker`). Do **not** re-run
  Terraform or re-provision, and do not retry more than three times; investigate any other failure
  rather than retrying it.
- `postdeploy:infra:apply` should write `terraform -chdir=infra output -json` to the ignored
  `infra/outputs.json` file.
- `pnpm deploy` must provision infrastructure before building and uploading code.
- `pnpm teardown` must delete the deployed Worker before destroying Terraform infrastructure.
- Add `destroy-containers` and `empty-r2-bucket` cleanup steps when the demo uses Containers or R2;
  order them before `terraform destroy` as documented by the toolkit deployment guidance.
