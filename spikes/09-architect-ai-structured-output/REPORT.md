# Spike 09 Report: Workers AI Structured Architecture Output

## Source-verified findings

- Cloudflare's JSON Mode documentation, retrieved 2026-08-07, specifies `response_format: { type: "json_schema", json_schema: <schema> }` for Workers AI and lists `@cf/meta/llama-3.3-70b-instruct-fp8-fast` as JSON Mode capable.
- The same documentation says JSON Mode does not guarantee schema adherence and the application must handle `JSON Mode couldn't be met` failures. This spike therefore validates the returned payload independently.
- The deployed binding is configured only as `ai: { binding: "AI" }`; it has no `remote: true` option and this spike never invokes `wrangler dev`.

## Local-verified findings

- `npm run check` passed on 2026-08-07: generated binding types, strict TypeScript checking, `terraform fmt -check`, and `terraform validate`.
- Wrangler-generated types identify the AI binding as `AI: Ai`; no hand-maintained binding interface is present.
- The generated runtime types are required instead of `@cloudflare/workers-types`; using both causes conflicting DOM/runtime declarations.

## Deployed findings

Run 2026-08-07 used only `npm run run`: Terraform provisioned the hostname-wide bypass policy/application, Wrangler deployed the Worker, and `scripts/probe.mjs` issued plain HTTPS `POST /probe` requests. The script called no Cloudflare API or model endpoint directly. It recorded results in ignored `artifacts/probe-results.json` before cleanup.

The workers.dev route returned an edge 404 immediately after deployment; the first `small` request retried after 10 seconds and then reached the Worker. Subsequent requests reached it first try. This is a route-propagation observation, not an AI failure.

| Fixture | Adapter | Binding accepted request | Validation | Model latency | HTTP wall latency | Response shape | Failure |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| small | `response_format` | yes | valid | 4,584 ms | 4,801 ms | wrapper: `response`; payload: `title`, `nodes`, `edges` | none |
| small | `guided_json` | yes | valid | 3,653 ms | 4,801 ms | larger wrapper including `response`; payload: `title`, `nodes`, `edges` | none |
| medium | `response_format` | yes | valid | 17,456 ms | 18,169 ms | wrapper: `response`; payload: `title`, `nodes`, `edges` | none |
| medium | `guided_json` | yes | valid | 4,558 ms | 18,169 ms | larger wrapper including `response`; payload: `title`, `nodes`, `edges` | none |
| invalid | `response_format` | no | not reached | 19,417 ms | 19,559 ms | not returned | model/binding rejected the impossible schema request |
| invalid | `guided_json` | yes | valid | 4,296 ms | 19,559 ms | larger wrapper including `response`; payload: `title`, `nodes`, `edges` | model followed the schema, not the request for an unknown product |

The reported wall latency includes both adapter calls because the Worker deliberately executes the two safe candidates in parallel. Individual `elapsedMs` measures only its `env.AI.run()` await. No prompt, generated payload, model text, or error text was returned or logged.

## Intended adapter and contract

- Model candidate: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Candidate adapters tested inside the deployed Worker: documented `response_format` and legacy candidate `guided_json`.
- Request: fixed system/catalog instruction, one committed fixture prompt, `max_tokens: 600`, `temperature: 0`, and one adapter-specific schema property.
- Response: the Worker retains model output; it returns only fixture ID, adapter/model metadata, elapsed time, response/payload type and top-level keys, and independent validation code.
- Schema: 679 bytes when JSON-serialized by the Worker. It permits `workers`, `d1`, `r2`, `kv`, and `queues`; 2-8 nodes; 0-10 typed edges; no additional properties.
- Fixtures: `small` requests a minimal API/data system; `medium` requests asynchronous image processing; `invalid` requests an unknown product to prove deterministic rejection.

## Versions

| Component | Version |
| --- | --- |
| Node.js | 26.7.0 |
| npm | 11.19.0 |
| Terraform | 1.15.8 |
| Cloudflare provider | `~> 5.22.0` |
| dotenv provider | `~> 1.0` |
| Wrangler | 4.115.0 |
| TypeScript | 6.0.3 |
| workerd | 1.20260722.1 |
| `@types/node` | 26.1.2 |

## Commands and cleanup evidence

Executed commands: `npm install`, `npm run check`, and `npm run run`.

`npm run run` executes `terraform apply`, waits 15 seconds for the Access app, deploys with Wrangler, then drives the external plain HTTP probe. Its `finally` path runs `wrangler delete --force` before `terraform destroy -auto-approve`.

Cleanup evidence from the final run: `workerDeleteExitCode: 0`; `accessDestroyExitCode: 0`. Terraform reported two Access resources destroyed. No Worker, Access application, Access policy, or storage resource remains from the spike.

## Decision

Use `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with the documented `response_format: { type: "json_schema", json_schema }` request for the architecture Workflow. Treat `guided_json` as an observed compatibility behavior, not the selected adapter: its response wrapper is substantially less stable and it did not produce the deliberate-invalid failure needed for this contract. Retain `small`, `medium`, and `invalid` as fixture IDs for later tests; the Workflow must classify a JSON Mode/model rejection as a durable failed proposal and independently validate every accepted payload.
