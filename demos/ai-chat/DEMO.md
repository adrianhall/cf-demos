# AI Model Playground Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/ai-chat`.
2. Prepare a factual prompt for the fast, non-reasoning default model, and a reasoning prompt (a small logic or arithmetic puzzle) for a reasoning model.
3. Have one browser identity ready to sign in as (any account recognized by the deployed Access identity provider).
4. Open **Workers & Pages → ai-chat → Logs** in a separate browser tab.
5. Open the Cloudflare dashboard's **Workers AI** metrics page (Account Home → Workers AI) in a third tab, to show the product-side view alongside the Worker's own logs.

## Presentation Flow

1. Open `https://ai-chat.cfapps.uk/` and sign in through Cloudflare Access. The header shows the verified identity and an unconditional **Sign out** control (`/cdn-cgi/access/logout`).
2. Leave the model selector on its default, **Granite 4.0 H Micro** (IBM's small, fast, non-reasoning model — the cheapest catalog entry), type the prepared prompt, and submit. Watch the animated activity dots, then the answer arriving **token by token** rather than appearing all at once. The turn ends with a footer reporting time-to-first-token, total time, and prompt/completion token counts.
3. Ask a **follow-up question** that depends on the previous answer. Point out that the whole conversation is sent with every request — the Worker itself stores nothing; the browser tab is the only place the conversation exists.
4. Switch to a **reasoning model** (DeepSeek R1 Distill Qwen 32B, GLM 4.7 Flash, or Gemma 4) and ask the prepared reasoning prompt. A collapsed **Thinking** panel appears and fills in first; expand it to show the model's reasoning, then collapse it and watch the final answer stream below it. Switch back to Granite or Llama 4 Scout and note that **no** Thinking panel appears for a non-reasoning model — that contrast is the point.
5. Raise the **temperature** slider, resubmit a similar prompt, and note the different character of the response. Point out that the slider's range changes per model — DeepSeek and Granite accept up to `5`, while Llama 4 Scout, GLM, and Gemma cap at `2` — because the Worker clamps to each model's own descriptor, not one shared range.
6. Start a long generation and press **Stop** mid-stream. The response halts immediately and the turn is marked "Generation stopped" — this cancels the upstream Workers AI reader, not merely the browser's display of it, so the model actually stops running (and billing) for the unread remainder.
7. Press **Export** and open the downloaded Markdown transcript. Show the models, parameters, per-turn latency, token usage, and the preserved thinking sections (as collapsible `<details>` blocks) for every turn so far.
8. Switch to the **Workers Logs** tab and locate `ai_prompt_submitted`, `ai_first_token`, `ai_stream_completed`, and — since Stop was used — `ai_stream_aborted`, correlated by `requestId`. Point out that they carry model, TTFT, total duration, and token counts — and that **no prompt or completion text appears anywhere in the logs**.
9. Switch to the **Workers AI** metrics tab and show the same activity from the product side: requests per model and neurons consumed.

## Expected Results

- Unauthenticated navigation and unauthenticated API requests are rejected by Access before reaching application logic — `/api/*` returns a JSON `401`, never an HTML sign-in redirect.
- A signed-in identity sees their own verified email in the header and an unconditional logout control.
- Every catalog model streams its answer incrementally; only the reasoning models show a Thinking panel, and it fills in before the final answer.
- Stop reliably halts generation and is reflected in both the UI and the upstream cancellation.
- Export produces a complete, accurate Markdown transcript of the session so far.
- Workers Logs show one correlated event sequence per turn with zero prompt/completion content.

## Where To Observe State

- **Worker logs:** Workers & Pages → `ai-chat` → Logs.
- **Traces:** Workers & Pages → `ai-chat` → Observability → Traces; sampling is 10%.
- **Workers AI metrics:** Account Home → Workers AI → requests/neurons per model.
- **Access application:** Zero Trust → Access controls → Applications → `ai-chat`.

Run `npm run teardown` after the presentation; see README.md for details.
