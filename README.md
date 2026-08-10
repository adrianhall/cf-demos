# Cloudflare Developer Platform Demos

A monorepo of complete, independently deployable demos of the Cloudflare
Developer Platform. Each demo lives under `demos/<name>` with its own
infrastructure, source, tests, and deployment scripts — see `AGENTS.md` for
the full repository contract.

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
  exist. Pass `-- --force` to regenerate every demo's `.env` (for example,
  after rotating the API token).
- Pass `-- --dry-run` to preview what would be written without touching any
  file.
- `DEMO_NAME` is deliberately never overridden: it names each demo's Worker
  and is owned by that demo's own `.env.example`, even though the root
  `.env.example` also declares a `DEMO_NAME` placeholder.
- A root `.env` value is only applied to a demo if that demo's own
  `.env.example` declares the same key. For example, `ADMIN_EMAIL` in the
  root `.env` only propagates to the demos that declare it
  (`url-shortener`, `architect`, `agentic-ai-chat`).
- Any key a demo declares that the root `.env` doesn't supply is left at its
  `.env.example` default (commonly a `<from-dashboard>`-style placeholder);
  `npm run update-env` prints which keys still need filling in by hand.
- New demos need no changes here — `npm run update-env` discovers every
  `demos/*/.env.example` at runtime.

This command only manages `.env` files. Deployment and teardown remain
per-demo:

```sh
cd demos/<name>
npm run deploy
npm run teardown
```

## Testing the tooling

```sh
npm test
```
