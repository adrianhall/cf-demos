# AI Model Playground Demo Guide

## Status

This guide currently covers **Phase 1 and Phase 2** of `docs/05-AI-CHAT.md`: baseline
infrastructure and the fully authenticated Cloudflare Access shell. The model catalog, streaming
inference, and the full playground UI are added in later phases — this is not yet the complete
demo flow described in the scenario document. Update this guide as later phases land.

## Purpose

This demo will show a single-page chat playground where a signed-in user picks a curated Workers
AI model, adjusts a couple of validated parameters, and holds a multi-turn conversation streamed
token-by-token to the browser. It is the curriculum's introduction to **Workers AI**. Today, it
demonstrates the piece that has to be right before any of that: a Worker, a custom domain, and a
Cloudflare Access application that gates the entire hostname because Workers AI inference is
billable compute.

## Cloudflare Capabilities (Implemented So Far)

- **Cloudflare Access** gating the entire `ai-chat.cfapps.uk` hostname with a single self-hosted
  application backed by an `allow` policy — no public bypass application, since every route will
  eventually trigger billable inference.
- **Workers** serving the API and, through the `ASSETS` binding, the built Vue SPA.
- **Workers Logs and automatic tracing**, enabled via Terraform with explicit sampling.
- The `AI` binding is declared in `wrangler.jsonc.tpl` (`remote: true`, since Workers AI has no
  local simulator) but is not yet called from any route.

## Demonstration Prerequisites

1. Deploy from `demos/ai-chat` with `npm run deploy`.
2. Have one browser identity ready to sign in as (any account recognized by the deployed Access
   identity provider).
3. Open **Workers & Pages → ai-chat → Logs** in a separate browser tab.

## Presentation Flow (Current)

1. Open `https://ai-chat.cfapps.uk/` without signing in first. Show that Cloudflare Access blocks
   the request before it ever reaches the Worker or the static assets layer — there is no
   anonymous route.
2. Sign in through the configured identity provider. The header shows the verified identity and
   an unconditional **Sign out** control (`/cdn-cgi/access/logout`).
3. Point out the placeholder message confirming the signed-in state — the model selector,
   streaming transcript, and composer are not implemented yet.
4. Open **Workers & Pages → ai-chat → Logs** and show a request to `/api/me` — a normal,
   informational request/response log with no prompt or Access-token content.
5. Open the Cloudflare dashboard's **Workers AI** metrics page to note it currently shows no
   activity for this Worker — nothing calls the binding yet.

## Expected Results

- Unauthenticated navigation and unauthenticated `/api/me` requests are rejected by Access before
  reaching application logic.
- A signed-in identity sees their own verified email in the header.
- The unconditional logout control is present and functional regardless of identity.

## Where To Observe State

- **Worker logs:** Workers & Pages → `ai-chat` → Logs.
- **Traces:** Workers & Pages → `ai-chat` → Observability → Traces; sampling is 10%.
- **Access application:** Zero Trust → Access controls → Applications → `ai-chat`.

## Local Demonstration

Run `npm start` and open the local Vite address. The development-only Access plugin offers
`alice@example.com` and `bob@example.com` for one-click local sign-in. Because the `AI` binding
has no local simulator, `vite dev` opens a real, credentialed session against the account in
`.env` even though no inference happens yet — see `README.md`, "Workers AI Has No Local
Simulation".

## Cleanup

Run `npm run teardown` from `demos/ai-chat` after the presentation. It removes the Access
application and policy, custom domain, and Worker. Workers AI provisions nothing, so there is no
additional cleanup step for it.
