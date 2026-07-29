# Tasks (Personalized TODO App)

An independently deployable Cloudflare Workers, Cloudflare Access, and D1 demo. Each authenticated Access identity can manage only its own TODOs.

## Architecture

```text
Browser -> Cloudflare Access -> Worker static assets and /api/* routes -> D1
                                      |
                                      +-> Workers Logs: TODO mutation events
```

Terraform owns the Worker service, D1 database, custom domain, Access application and policy, and observability settings. Wrangler owns Worker code versions, D1 schema migrations, and static assets. Access protects pages at the edge and `cloudflareAccess()` independently validates `/api/*` JWTs. Every D1 query scopes data to the verified email as `user_id`, so users cannot read or mutate each other's TODOs.

The demo uses one generated, gitignored `wrangler.jsonc`:

- `wrangler.jsonc.tpl` is the committed template with Terraform placeholders.
- `generate-wrangler -c -l infra/local-outputs.json` fills local values from the committed
  `infra/local-outputs.json` when no config exists.
- `generate-wrangler -cf --terraform infra` replaces it with Terraform outputs during deployment.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare zone for `cfapps.uk` with no conflicting `tasks.cfapps.uk` CNAME.
- A Cloudflare Access organization with an enabled identity provider.
- An API token scoped to the target account and zone with:
  - Account: Workers Scripts - Edit
  - Account: Access: Apps and Policies - Edit
  - Account: D1 - Edit

Use encrypted remote Terraform state for shared or production operation. Do not commit local state.

## Configuration

```sh
cd demos/todo-app
cp .env.example .env
```

Set these `.env` values:

- `CLOUDFLARE_API_TOKEN`: token with the listed permissions.
- `CLOUDFLARE_ACCOUNT_ID`: account owning the Worker, D1 database, and Access application.
- `CLOUDFLARE_ZONE_ID`: zone ID for `cfapps.uk`.
- `DEMO_DOMAIN`: `cfapps.uk`.
- `DEMO_NAME`: `tasks`, producing `tasks.cfapps.uk`.

Do not commit `.env`, Terraform state, generated `wrangler.jsonc`, or generated `worker-configuration.d.ts`.

## Local Development

```sh
npm install
npm start
```

The start hook generates local Wrangler bindings, applies the D1 migration to Miniflare's local SQLite database, and starts Vite. The development-only Access plugin offers `alice@example.com` and `bob@example.com`; the always-visible **Sign out** control clears either the local or production Access session. Local data is stored in `.wrangler/` and never touches the deployed D1 database.

## API

Every endpoint requires a valid Cloudflare Access identity. Errors use RFC 9457 `application/problem+json` responses.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/me` | Return the verified identity email. |
| `GET` | `/api/todos` | List the current user's TODOs. |
| `POST` | `/api/todos` | Create from `{ "title": "..." }`. |
| `PATCH` | `/api/todos/:id` | Rename and/or complete the current user's TODO. |
| `DELETE` | `/api/todos/:id` | Delete the current user's TODO. |
| `DELETE` | `/api/todos/completed` | Delete the current user's completed TODOs. |

## Testing And Validation

```sh
npm run check
npm test
npm run test:coverage
npm run build
terraform -chdir=infra fmt -check
terraform -chdir=infra init
terraform -chdir=infra validate
```

The `worker` project covers validation, Access path policy, and repository ownership predicates. The `client` project uses jsdom, Vue Test Utils, and Pinia test utilities. The `integration` project runs the real Worker in `workerd` with Miniflare D1. It verifies unauthenticated rejection for every API route, per-user isolation, and the create, complete, list, and delete workflow.

`npm run test:coverage` uses `@vitest/coverage-istanbul` and writes HTML and LCOV reports to gitignored `coverage/`. It reports coverage without an enforced threshold.

## Deployment

```sh
cd demos/todo-app
cp .env.example .env
# Fill in real values, then:
npm run deploy
```

`npm run deploy` runs Terraform initialization and apply, regenerates Wrangler configuration and bindings from Terraform outputs, applies remote D1 migrations, builds the application, and deploys the Worker.

Verify deployment:

1. Visit `https://tasks.cfapps.uk` and authenticate through Access.
2. Create a task, mark it complete, then delete it.
3. Sign out, sign in as another identity, and confirm the first task is not visible.
4. In **Workers & Pages → tasks → Logs**, filter for a TODO mutation event such as
   `todo_created` or `todo_completed`.

## Observability

Terraform enables persisted Workers Logs at 100% sampling and traces at 10% sampling. Successful
mutations emit informational `todo_created`, `todo_completed`, `todo_uncompleted`,
`todo_removed`, or `completed_todos_removed` events. Per-item events contain only the task UUID;
all events deliberately exclude task text, identity data, tokens, and authorization headers.

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| Custom domain attach fails with `100124` | Re-run `npm run deploy`; Terraform's inert bootstrap deployment satisfies the required Worker deployment ordering. |
| Access sign-in is denied | Confirm an identity provider is enabled in the target Zero Trust organization. |
| `/api/*` returns `401` | Sign in through Access at `https://tasks.cfapps.uk`; API routes require the signed Access session. |
| D1 migration fails | Ensure Terraform apply completed, then re-run `npm run deploy` to apply `migrations/0001_create_todos.sql`. |
| Logs are missing | Confirm the deployed Worker is `tasks` and filter Workers Logs for a TODO mutation event. |

## Teardown

```sh
cd demos/todo-app
npm run teardown
```

Terraform removes the Access application and policy, Worker, custom domain, and D1 database. The teardown hook removes generated Wrangler configuration and binding types, leaving no named or billable demo resources behind.
