# AI Gateway exceptions

**One reviewed inference operation bypasses AI Gateway because the Gateway rejects the model's
required binding input shape.**

## Why this file exists even when empty

Routing all model traffic through AI Gateway is an invariant of this demo, not a default that
happens to be switched on. An empty register is the statement that the invariant currently holds —
which is more useful than the file not existing, because "no exceptions" and "nobody has looked" are
indistinguishable from an absent document.

A single `env.AI.run()` call without a gateway option is a one-line change. It removes cost
reporting, caching, rate limiting, and attribution from one panel while every other panel still
displays "Routed through AI Gateway". That is a quiet, plausible regression, and this register is
the mechanism that makes it loud.

## What counts as an exception

Only a **genuine inference call that cannot be routed through AI Gateway because of a platform
limitation**. Convenience, unfamiliarity, and "the provider's SDK was easier" are not platform
limitations.

Explicitly **not** exceptions:

- **View Tokens.** It tokenizes in the browser and never contacts a model. There is no request to
  route, no log to read, and nothing to charge. A panel that performs no inference cannot be an
  exception to a rule about inference.
- Anything that _could_ be routed through the gateway but currently is not. That is a defect, and
  the checker reports it as one.

## Adding an exception

An exception has to exist in three places, and `pnpm check:gateway` fails unless all three agree:

1. **Typed entry** in
   [`src/worker/domain/gateway-exceptions.ts`](./src/worker/domain/gateway-exceptions.ts), with
   every field of `GatewayException` completed.
2. **Call-site annotation** — a `NO_AI_GATEWAY: <id>` comment on the line that bypasses the gateway,
   in the file that bypasses it. An annotation elsewhere does not license a bypass here.
3. **A section below**, with an `### <id>` heading matching the typed entry exactly.

The section must state the platform limitation by name, what observability is lost (normally cost,
token usage, cache state, and the log identifier), and what the panel shows the user instead. The UI
must never claim gateway routing it does not have: a panel covered by an exception renders the
alternative badge, not the standard one.

## Registered exceptions

### flux-2-workers-ai-multipart-stream

- **Panel and route:** Remix Image — `POST /api/remix-image`
- **Operation:** Reference-image editing with `@cf/black-forest-labs/flux-2-klein-4b`,
  `@cf/black-forest-labs/flux-2-klein-9b`, or `@cf/black-forest-labs/flux-2-dev`
- **Platform limitation:** This Cloudflare-hosted FLUX.2 family uses the same Workers AI multipart
  binding contract with a `ReadableStream` body. Sending it through the named Gateway fails before
  inference with `AI Gateway does not support ReadableStreams yet.` The same binding call works only
  when gateway options are omitted.
- **Observability lost:** There is no AI Gateway log identifier, Gateway-reported cost, cache state,
  Gateway duration, or user-attributed Gateway metadata for these calls. Worker diagnostics still
  record the task, model, run ID, input shape, elapsed time, and outcome without content or email.
- **User-facing behaviour:** The model selector and Run Details identify these FLUX.2 models as a
  documented direct Workers AI exception. Cost is `Not applicable`, never `$0.00`. Third-party
  models in the same panel remain Gateway-routed and require prepaid Gateway credits.
- **Tracking:** No public product-gap issue is linked. The runtime error precisely identifies the
  missing Gateway capability; this exception should be removed as soon as Gateway supports the
  binding's multipart `ReadableStream` shape.

Chat, delivered in phase 3, is the first panel to perform real inference, and it needed no
exception: `runStream` assembles its gateway options in the same single place the synchronous path
does, so a streamed call cannot omit them either. Streaming is where a shortcut is most tempting,
which is why both paths are pinned by their own tests.

Create Image, delivered in phase 4, needed no exception either. It is the first panel whose model
returns **binary** output rather than text, and binary is the other place a shortcut is tempting —
it is easy to reach for `fetch` against a provider endpoint when a binding's return type is awkward.
It does not: the image arrives through the same `run()` call every other panel uses, and the
shape-normalisation that absorbs the providers' disagreement happens _after_ the gateway, in the
application tier, where it has no way to bypass anything.
