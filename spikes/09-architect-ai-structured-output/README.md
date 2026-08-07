# Spike 09: Workers AI structured architecture output

Disposable deployed verification of Workers AI structured output through a minimal Worker and a hostname-wide Cloudflare Access bypass application.

Run `npm install`, then `npm run check`, then `npm run run`. The runner provisions only Access resources, deploys the Worker, probes committed fixture IDs over HTTPS, records `artifacts/probe-results.json`, deletes the Worker, and destroys Access resources.

The public surface is only `POST /probe` with `{ "fixture": "small" | "medium" | "invalid" }`; fixture text and model output are never returned or logged.
