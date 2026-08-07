An authenticated collaborative architecture shell based on Cloudflare Workers, Static Assets, Access, Durable Objects, D1, R2, Workers KV, Workflows, and Workers AI.

## Prerequisites

- Node.js 24+, npm 11+, and Terraform 1.10+.
- An active Cloudflare zone for `architect.cfapps.uk` and a Cloudflare Access team.
- An API token with the permissions listed in `.env.example`.

## Configure

1. Copy `.env.example` to `.env`.
2. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_TEAM_DOMAIN`, and `CLOUDFLARE_API_TOKEN`.
3. Keep `DEMO_NAME="architect"` and set `DEMO_DOMAIN="cfapps.uk"` for the documented hostname.
4. Run `npm install`.

## Local Development

Run `npm start`, then open `http://localhost:5173`. The local Access screen offers Architect and Customer identities. Use `/app` (redirects to `/app/diagrams`) to open the diagram library, create a diagram from a starter blueprint, and open its editor. The shell's Sign out control is unconditionally available.

## Testing

- `npm test` runs worker, client, and Workers-runtime integration tests.
- `npm run test:coverage` reports authored-source coverage.
- `npm run check` runs formatting, linting, type checks, and Terraform validation after `terraform -chdir=infra init`.

## Deploy

1. Confirm no conflicting DNS record exists for `architect.cfapps.uk`.
2. Run `npm run deploy`.
3. Open `https://architect.cfapps.uk` for the public landing page and `https://architect.cfapps.uk/app` to complete Access sign-in and reach the diagram library.
4. Confirm `GET /api/me` succeeds only after Access authentication, then create a diagram and confirm it reopens with the same document after a page reload.

Provisioned resources: the Worker and custom domain, public and authenticated Access applications, D1 `DB` (diagram directory and owner membership), R2 `SNAPSHOTS`, KV `SHARES`, one SQLite `DiagramRoom` Durable Object namespace (authoritative per-diagram document and revision), and the Workflow declaration.

| Problem | Resolution |
| --- | --- |
| Local app returns an Access error | Use the local login screen or `/cdn-cgi/access/logout`, then choose an identity. |
| Terraform cannot attach the domain | Check the hostname has no conflicting DNS record and rerun `npm run deploy`. |
| Terraform validation lacks providers | Run `terraform -chdir=infra init` once. |

## Teardown

Run `npm run teardown`. The preteardown hook deletes the Worker, empties R2, then Terraform removes the registered Worker, Durable Object namespace, Workflow declaration, D1, KV, Access, and custom-domain resources.

See [DEMO.md](./DEMO.md) for the presenter flow and [EXPLAIN-DEMO.md](./EXPLAIN-DEMO.md) for implementation details.
