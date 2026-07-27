# Decision Log

These decisions, gleaned from building `demos/url-shortener`, have been rolled
into `AGENTS.md` (Resource Ownership, Public Access, Source Organization,
Testing And Verification, and Observability And Security). Keep this log as
the historical rationale; update `AGENTS.md` first when a future demo reveals
the guidance below needs to change again.

## 1. wrangler.local.jsonc vs. wrangler.jsonc.tpl

There were problems with running vite with an alternate wrangler.jsonc, so the decision was made that wrangler.local.jsonc would be abandoned.  The approved way is to use a scripts/generate-local-wrangler.js and use that to generate a local version of wrangler.jsonc.  

Since local dev needs a separate environment, the .dev.vars overrides ENVIRONMENT (check this in if there are no secrets in it).  Also, package.json scripts was extensively modified for this new situation and to create the proper workflow.

## 2. vitest projects

We use vitest projects to organize tests.  Don't use playwright.  There is a vitest.config.ts for each type of test - integration in tests/integration, worker in src/worker and client in src/client.  Unit tests sit alongside the source file under test.  Integration tests for the API are separate.

We also added coverage with istanbul to the setup

## 3. Deployment of the worker

Since you can't connect the worker to a domain name until you have a worker deployment, we decided to allow an initial deployment of the worker which will then be overwritten by the wrangler deploy version.

## 4. Source organization

We organize source files for testability.  Do NOT put everything in one file.

## 5. Logging

Just use cloudflareLogger() - don't try to be fancy with log levels or anything like that.

## 6. R2 teardown uses the dashboard empty-bucket API

The R2 dashboard's observed `DELETE /client/v4/accounts/{account_id}/r2/buckets/{bucket_name}/objects?prefix=` request empties a bucket with the ordinary Cloudflare deployment token when it has `Workers R2 Storage - Edit`. The `spikes/empty-r2-bucket` validation confirmed the call deletes every object without S3 credentials or a Terraform-created account token.

For teardown, copy `demos/media-drop/scripts/empty-r2-bucket.js` into demos that need R2 cleanup and use it in preference to `@adrianhall/cloudflare-scripts`' `empty-r2-bucket` command. It reads the deployment token from the demo's `.env` and accepts the Terraform-derived bucket name. The endpoint remains undocumented, so this decision must be revisited if Cloudflare publishes, changes, or removes the API.

## NEW DECISIONS

New decisions will be located below here before they are incorporated, and moved above this heading when they have been incorporated.
