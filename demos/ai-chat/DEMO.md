# AI Model Playground Demo Guide

## Purpose

This demo shows a single-page chat playground where a signed-in user picks a curated Workers AI
model, adjusts a couple of validated parameters, and holds a multi-turn conversation streamed
token-by-token to the browser. It is the curriculum's introduction to **Workers AI**: obtaining an
async token stream from a binding (`env.AI.run(model, { messages, stream: true })`), re-emitting it
incrementally as the Worker's own Server-Sent Events, and rendering it progressively — never
buffering the whole answer before responding, and never calling Cloudflare's REST API from inside
the Worker.

## Cloudflare Capabilities Demonstrated

- **Workers AI** (`AI` binding) — serverless GPU inference reached purely through a binding; there
  is no provisioned resource and no product-specific teardown step.
- **Streaming to the browser** — the Worker decodes the model's raw SSE bytes, normalizes them
  across two different upstream shapes, separates reasoning from the answer, and re-emits its own
  typed SSE frames as they are produced.
- **Cloudflare Access** gating the entire `ai-chat.cfapps.uk` hostname with a single self-hosted
  application backed by an `allow` policy — no public bypass, since every request triggers billable
  inference.
- **Workers** serving both the API and, through the `ASSETS` binding, the built Vue SPA.
- **Workers Logs and automatic tracing**, showing correlated, content-free structured logs for
  every stage of a turn.

## Demonstration Prerequisites

1. Deploy from `demos/ai-chat` with `npm run deploy`.
2. Have one browser identity ready to sign in as (any account recognized by the deployed Access
   identity provider).
3. Open **Workers & Pages → ai-chat → Logs** in a separate browser tab.
4. Optionally, open the Cloudflare dashboard's **Workers AI** metrics page (Account Home → Workers
   AI) in a third tab, to show the product-side view alongside the Worker's own logs.

## Presentation Flow

1. Open `https://ai-chat.cfapps.uk/` and sign in through Cloudflare Access. The header shows the
   verified identity and an unconditional **Sign out** control
   (`/cdn-cgi/access/logout`).
2. Leave the model selector on its default, **Granite 4.0 H Micro** (IBM's small, fast,
   non-reasoning model — the cheapest catalog entry), type a prompt, and submit. Watch the
   animated activity dots, then the answer arriving **token by token** rather than appearing all
   at once. The turn ends with a footer reporting time-to-first-token, total time, and prompt/
   completion token counts.
3. Ask a **follow-up question** that depends on the previous answer. Point out that the whole
   conversation is sent with every request — the Worker itself stores nothing; the browser tab is
   the only place the conversation exists.
4. Switch to a **reasoning model** (DeepSeek R1 Distill Qwen 32B, GLM 4.7 Flash, or Gemma 4) and
   ask a question that requires working something out. A collapsed **Thinking** panel appears and
   fills in first; expand it to show the model's reasoning, then collapse it and watch the final
   answer stream below it. Switch back to Granite or Llama 4 Scout and note that **no** Thinking
   panel appears for a non-reasoning model — that contrast is the point.
5. Raise the **temperature** slider, resubmit a similar prompt, and note the different character
   of the response. Point out that the slider's range changes per model — DeepSeek and Granite
   accept up to `5`, while Llama 4 Scout, GLM, and Gemma cap at `2` — because
   `src/worker/chat/validation.ts` clamps to each model's own descriptor, not one shared range.
6. Start a long generation and press **Stop** mid-stream. The response halts immediately and the
   turn is marked "Generation stopped." — this cancels the upstream Workers AI reader, not merely
   the browser's display of it, so the model actually stops running (and billing) for the
   unread remainder.
7. Press **Export** and open the downloaded Markdown transcript. Show the models, parameters,
   per-turn latency, token usage, and the preserved thinking sections (as collapsible `<details>`
   blocks) for every turn so far.
8. Switch to the **Workers Logs** tab and locate `ai_prompt_submitted`, `ai_first_token`,
   `ai_stream_completed`, and — if Stop was used — `ai_stream_aborted`, correlated by
   `requestId`. Point out that they carry model, TTFT, total duration, and token counts — and
   that **no prompt or completion text appears anywhere in the logs**.
9. Switch to the **Workers AI** metrics tab and show the same activity from the product side:
   requests per model and neurons consumed.

## Talking Points

- **What to say while the dots are bouncing**: the first request to a given model after a period
  of inactivity has a materially higher time-to-first-token, because Workers AI has to provision
  GPU capacity for that model — the activity indicator exists specifically to make that visible
  rather than looking like a hang. A second prompt to the same model in the same session is
  noticeably faster.
- **Reasoning vs. non-reasoning contrast**: the catalog deliberately includes two non-reasoning
  models (Granite, Llama 4 Scout) and three reasoning models using two different mechanisms —
  DeepSeek's inline `<think>`/`</think>` text markers (parsed by a hand-written state machine,
  `src/worker/chat/reasoning.ts`) versus GLM/Gemma's separate `reasoning_content` JSON field (read
  directly by the `openai-chat` adapter, no parsing needed). Both land in the same UI panel.
- **What Workers AI is not**: there is no database, no conversation history stored server-side, and
  no external model provider — the entire "chat history" a user sees is what their own browser tab
  has accumulated in memory since the page loaded.
- **What "no content is logged" means**: `buildInferenceLogFields()`
  (`src/worker/chat/log-fields.ts`) is structured so that a prompt, an answer, an authorization
  header, or an Access JWT **cannot** end up in a log field even if a future change tried to smuggle
  one in — this is enforced by a dedicated unit test, not only by convention.

## Expected Results

- Unauthenticated navigation and unauthenticated API requests are rejected by Access before
  reaching application logic — `/api/*` returns a JSON `401`, never an HTML sign-in redirect.
- A signed-in identity sees their own verified email in the header and an unconditional logout
  control.
- Every catalog model streams its answer incrementally; only the three reasoning models show a
  Thinking panel, and it fills in before the final answer.
- Stop reliably halts generation and is reflected in both the UI and the upstream cancellation.
- Export produces a complete, accurate Markdown transcript of the session so far.
- Workers Logs show one correlated event sequence per turn with zero prompt/completion content.

## Where To Observe State

- **Worker logs:** Workers & Pages → `ai-chat` → Logs.
- **Traces:** Workers & Pages → `ai-chat` → Observability → Traces; sampling is 10%.
- **Workers AI metrics:** Account Home → Workers AI → requests/neurons per model.
- **Access application:** Zero Trust → Access controls → Applications → `ai-chat`.

## Local Demonstration

Run `npm start` and open the local Vite address. The development-only Access plugin offers
`alice@example.com` and `bob@example.com` for one-click local sign-in. Because the `AI` binding has
no local simulator, `vite dev` performs **real inference against real Workers AI** using the
credentials in `.env` — see `README.md`, "Workers AI Has No Local Simulation". The full flow above
works identically locally and on the deployed hostname.

## Cleanup

Run `npm run teardown` from `demos/ai-chat` after the presentation. It removes the Access
application and policy, custom domain, and Worker. Workers AI provisions nothing, so there is no
additional cleanup step for it.
