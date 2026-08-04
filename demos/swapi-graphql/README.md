# SWAPI GraphQL

An authenticated, read-only SWAPI GraphQL service based on Cloudflare Workers, D1, and Access.

For the presentation flow, see [DEMO.md](./DEMO.md); for implementation details, see [EXPLAIN-DEMO.md](./EXPLAIN-DEMO.md).

## Prerequisites

- Node.js 24 or later and npm 11 or later.
- Terraform 1.10 or later.
- A Cloudflare account with an active `cfapps.uk` zone, or equivalent values for a zone that can host the configured hostname.
- A Cloudflare Zero Trust team with at least one configured identity provider. The deployed Access policy permits any identity that signs in through that provider.
- An API token with the permissions listed in [`.env.example`](./.env.example).

## Environment configuration

1. Copy the example file:

   ```sh
   cp .env.example .env
   ```

2. Set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, and `CLOUDFLARE_TEAM_DOMAIN` from the Cloudflare dashboard. Keep `DEMO_NAME=swapi-graphql` and set `DEMO_DOMAIN` to the active zone that will contain the hostname.
3. Confirm that the resulting `${DEMO_NAME}.${DEMO_DOMAIN}` hostname has no conflicting DNS record.

Terraform provisions the Worker registration, custom domain, hostname-wide Access application and policy, and D1 database. Wrangler deploys the Worker code and binds D1 as `DB`.

## Local development

```sh
npm install
npm run db:migrate:local
npm run start
```

Open `http://localhost:8787/graphql`. Local development uses the committed placeholder D1 binding and the local database under `.wrangler/`; it does not emulate the production Access login wall.

## Testing

```sh
npm run check
npm test
npm run test:coverage
npm run build
```

## Deploy

```sh
npm run deploy
```

This initializes and applies Terraform, forcibly regenerates `wrangler.jsonc` and binding types from Terraform outputs, applies remote D1 migrations, type-checks the Worker, and deploys it. Do not run the individual remote migration or deployment steps before Terraform has provisioned the resources.

## Verify

1. Open `https://swapi-graphql.cfapps.uk/graphql`, replacing the hostname if `DEMO_DOMAIN` was changed.
2. Complete the Access login and run:

   ```graphql
   { films { title episodeId releaseDate } }
   ```

3. In **Workers & Pages** > **swapi-graphql** > **Logs**, confirm a `GraphQL request completed` record with `operationName`, `durationMs`, and `statementCount`.

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| Terraform cannot create the custom domain | Remove the conflicting DNS record for the configured hostname and rerun `npm run deploy`. |
| Access redirects cannot complete | Confirm `CLOUDFLARE_TEAM_DOMAIN` is correct and that the Zero Trust team has an enabled identity provider. |
| Remote migration fails | Confirm the API token includes `D1 : Edit`, then rerun `npm run deploy`; applied migrations are tracked by D1. |
| Generated config contains local values | Run `npm run deploy`; its production deploy step forcibly replaces the local generated configuration. |

## Teardown

```sh
npm run teardown
```

This deletes the deployed Worker, destroys the Terraform-managed Worker registration, D1 database, custom domain, Access application, and policy, then removes generated Wrangler configuration and binding types. It requires the generated `wrangler.jsonc` left by a successful deploy; do not remove it before teardown.
