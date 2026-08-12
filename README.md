# Cloudflare Developer Platform Demos

A monorepo of complete, independently deployable demos of the Cloudflare
Developer Platform. Each demo lives under `demos/<name>` with its own
infrastructure, source, tests, and deployment scripts — see `AGENTS.md` for
the full repository contract.

## Demos

The following demos are available:

| Name | Description |
|------|-------------|
| url-shortener | A basic sample demonstrating KV and static assets |
| todo-app | A basic sample demonstrating D1 and static assets |
| media-drop | A basic sample demonstrating D1, R2, and static assets |
| enterprise-chat | A basic chat app using Durable Objects |
| ai-chat | A basic AI chat app |
| agentic-chat | An agentic AI chat that provides session resumption and tool calling |
| pr-review-agent | An agent for reviewing GitHub pull requests |
| swapi-graphql | A GraphQL service for the Star Wars API |
| architect | A Cloudflare Architect demonstrating collaboration, MCP and AI Chat |

## Prerequisites

Every single demo requires:

- A Cloudflare Dev Platform account and access to the dashboard
- Terraform v1.15.0 or later (earlier versions MAY work but have not been tested)
- Node v26.0.0 or later, with npm

To determine if you have all the right tools:

```bash
$ terraform --version
Terraform v1.15.8
on darwin_arm64

$ node --version
v26.7.0

$ npm --version
11.19.0
```

## Environment setup

Each demo requires its own `.env` (see that demo's `README.md` for the exact
deploy/teardown steps). Most of those values — the API token, account ID,
zone ID, domain, and Access team domain — are the same across every demo, so
you can maintain one repo-root `.env` and fan it out instead of editing each
demo's `.env` by hand.

1. Copy the root example and fill in real values:

   ```sh
   cp .env.example .env
   ```

2. Generate every demo's `.env` from its own `.env.example`, with the
   repo-root `.env` overriding the shared keys:

   ```sh
   npm run update-env
   ```

Notes:

- `npm run update-env` only creates a demo's `.env` if one doesn't already
  exist.
- Run `npm run update-env -- --dry-run` to preview what would be written
  without touching any file.
- Run `npm run update-env -- --force` to regenerate every demo's `.env` (for 
  example, after rotating the API token).

This command only manages `.env` files. Deployment and teardown remain
per-demo:

```sh
cd demos/<name>
npm run deploy
npm run teardown
```
