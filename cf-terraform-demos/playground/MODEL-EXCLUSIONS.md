# Model exclusions

**Cloudflare-hosted models that were considered for a panel and deliberately not registered, with
the reason for each.**

## Why this file exists

`src/worker/domain/models.ts` is a reviewed subset of the Cloudflare catalogue, not a scrape. That
makes every absence ambiguous: a model missing from a panel could have been examined and declined,
or could simply never have been looked at. Those are completely different facts, and only one of
them means the next person should not waste an afternoon re-probing it.

This register makes them distinguishable, in the same spirit as
[`AI-GATEWAY-EXCEPTIONS.md`](./AI-GATEWAY-EXCEPTIONS.md): the interesting entry is the one that
records a decision somebody already paid to learn.

It covers **exclusions only**. A model that is registered needs no entry here; its reviewed contract
and the reasoning behind it live in the descriptor comments in `models.ts`.

## Categories

- **Structural** — no panel fits the model's contract. Including it would mean inventing a feature,
  not adding a descriptor.
- **Upstream-broken** — the model is published in the catalogue but cannot currently be called.
  Nothing in this demo can fix it, and it is worth re-probing occasionally.
- **Editorial** — technically compatible, but registering it would make the demo worse. These are
  judgement calls and are argued rather than asserted.

Every entry names the panel it was considered for, the observed evidence, and the date it was
checked. An entry whose evidence is a guess is worse than no entry.

---

## Structural

### `@cf/runwayml/stable-diffusion-v1-5-inpainting` — Create Image

Inpainting requires a mask marking the region to regenerate, and Create Image has no concept of one
— it takes a text prompt and nothing else. Confirmed by the model rather than inferred:

```
3030: Model input is not valid: missing required input mask_image
```

Supporting it means building a mask-drawing surface, which is a feature rather than a descriptor.
_Probed 2026-10-06._

### `@cf/deepgram/flux` — Transcribe Audio

A real-time streaming transcription model that speaks only WebSocket:

```
8006: @cf/deepgram/flux only supports websocket connections
```

Verified against all three audio encodings the panel can produce, so this is the model's transport
and not a malformed request. Transcribe Audio uploads a finished file over HTTP and renders a
transcript; Flux emits turn-taking events over a live socket. The mismatch is the whole contract,
not a detail of it. _Probed 2026-10-06._

### `@cf/pipecat-ai/smart-turn-v2` — no panel

Catalogue task type **Dumb Pipe**. It detects conversational turn-taking in a live audio stream —
deciding when a speaker has finished — and emits no transcript, no classification, and no text.
Confirmed to require audio input with a `{ body, contentType }` shape. No panel in this demo
corresponds to what it does. _Probed 2026-10-06._

---

## Upstream-broken

### `@cf/utter-project/eurollm-9b-it` — Chat

Listed in the live catalogue and **not callable**. Every request returns:

```
4003: AI model does not have config
```

Reproduced through both `cf ai run` and the `env.AI` binding, with a minimal valid `messages` body.
This is a platform-side fault rather than a schema mismatch, so there is no request shape that would
succeed.

This model was explicitly requested for the Chat panel in the item-4 follow-on, and
`@cf/mistralai/mistral-small-3.1-24b-instruct` was registered in its place. It is recorded as broken
rather than declined: if Cloudflare publishes the missing config, it becomes a candidate again with
no further argument needed. _Probed 2026-10-06._

A separate note, for a different model and a different reason: `@cf/moonshotai/kimi-k2.7` was
requested and **does not exist** — it returns `5007: No such model`. The catalogue offers
`kimi-k2.7-code` and `kimi-k2.6`; the `-code` variant was probed, verified clean, and registered.

---

## Editorial

### `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` — Chat

**Leaks its chain-of-thought into the transcript.** Unlike every registered reasoning model, it puts
its monologue in the same field the panel renders rather than in `reasoning_content`:

```json
{ "response": "<think>\nOkay, the user is asking me to say \"hi\" in three words. Hmm, t…" }
```

Observed at 659–1,171 characters of monologue for a three-word request, over repeated trials.
`chat_template_kwargs.enable_thinking: false` does not suppress it (2/2 trials).

A `<think>`-stripping workaround was considered and rejected — see the QwQ entry immediately below
for why it would not generalise. With five reasoning models already registered that render cleanly
with no special handling, carrying this one buys nothing the panel does not already demonstrate.
_Probed 2026-10-06._

### `@cf/qwen/qwq-32b` — Chat

The same defect as above and strictly worse, which is why both are excluded rather than worked
around. QwQ streams 943–1,006 characters of reasoning into the rendered field **with no tags at
all**:

```
Okay, the user wants me to say "hi" in three words. Let me think. The…
```

There is no marker to strip. Any mitigation would have to guess where thinking ends and the answer
begins, which is exactly the kind of heuristic that works in a demo and fails in front of an
audience. `enable_thinking: false` does not help here either (2/2 trials). _Probed 2026-10-06._

### LoRA adapters — Chat

`@cf/google/gemma-2b-it-lora`, `@cf/google/gemma-7b-it-lora`,
`@cf/meta-llama/llama-2-7b-chat-hf-lora`, `@cf/mistral/mistral-7b-instruct-v0.2-lora`, and the other
catalogue entries flagged `lora`.

The exclusion is genuinely editorial rather than technical, and that was checked rather than
assumed: `@cf/google/gemma-2b-it-lora` was probed and does answer a `messages` request normally.

These are base models published for fine-tuning, intended to be served with an adapter attached.
Offered bare in a dropdown beside instruction-tuned models, they invite a comparison that teaches
the wrong thing — a visitor would read their weaker answers as a quality ranking rather than as
evidence that they are being used for something they are not for. _Probed 2026-10-06._

### Remaining Text Generation models — Chat

The catalogue carries 35 text-generation models and this demo registers 8. The rest are excluded as
a group, not individually: the panel's purpose is comparison, and a 35-entry dropdown makes
comparison harder rather than easier. The registered set was chosen to span the axes that change
what a visitor sees — price (a roughly 30× spread), context window (24K to 1M), reasoning versus
direct answering, and model size.

Several were probed and render perfectly well — `llama-3.1-8b-instruct-fp8`, `granite-4.0-h-micro`,
`gemma-sea-lion-v4-27b-it`, `qwen3-30b-a3b-fp8`, `gpt-oss-120b`. They are compatible and simply not
needed; any of them could be registered later with no code change.

One of those carries a finding worth keeping. `granite-4.0-h-micro` and `gemma-sea-lion-v4-27b-it`
return **no `response` field** in their non-streamed envelope, only `choices[0].message.content`.
Harmless for Chat, which always streams — but a non-streaming panel could not assume the shape the
other models use. _Probed 2026-10-06._
