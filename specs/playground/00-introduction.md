# Playground - an AI model playground

## Overview

**Playground** is a web-based, multi-modal workspace for trying AI models without first having to build an application around them. It presents a set of focused experiments behind one Worker and one consistent interface: choose a task, choose an available model, provide the task's input, adjust a small set of meaningful parameters, and inspect the result.

The demo is intended to teach two complementary Cloudflare capabilities:

- **Workers AI** provides access to models that run on Cloudflare's inference platform. The task panels should expose representative Workers AI models and their task-specific input and output formats.
- **AI Gateway** is the control point every inference request passes through. It provides observability, logging, analytics, caching, rate limiting, retries, and — importantly for this demo — per-request **cost** reporting. Every Workers AI model is reachable through AI Gateway, so the demo treats the Gateway as the default and only route.

This is one application rather than ten separately deployed demos. A shared Worker serves the shell and API routes, while the browser navigates between task panels. Each panel is deliberately narrow enough to explain one model capability well, but the common model picker, request status, result viewer, history, and diagnostics make it easy to compare tasks. The application should be useful as both a presenter-led Cloudflare demo and a hands-on model evaluation tool.

The experience should feel like a small, approachable version of a model laboratory rather than a generic chat application. It should favor visible inputs and outputs over hidden orchestration, show the model, gateway, latency, and cost for every request, and include example prompts or files so a first-time visitor can produce a result quickly.

## AI Gateway is mandatory

**Every AI request in this demo goes through an AI Gateway.** This is a design decision made by the demo authors, not a runtime option, and not a user preference. There is no UI toggle for it, no environment variable that disables it, and no "direct to Workers AI" fallback path.

Concretely:

- All inference uses `env.AI.run(model, inputs, { gateway: { id: <gateway-id> } })`, with the gateway ID supplied by a binding/configuration value rather than hardcoded per call site.
- Calls are made through **one shared inference helper** in the application tier. Task handlers must not call `env.AI.run()` directly, so the gateway option cannot be accidentally omitted in a new panel.
- The helper's type signature should make the gateway mandatory — the gateway identifier is a required argument, not an optional field with a default of "none".
- A unit test asserts that the helper always attaches a gateway, and that no module other than the helper references `env.AI.run`.
- The gateway itself is provisioned by the demo's infrastructure, so `pnpm deploy` creates it and `pnpm teardown` removes it. A gateway must not be created implicitly as a side effect of the first request in a deployed environment.

### Documented exceptions

Some interactions genuinely cannot traverse AI Gateway — for example a model/modality the Gateway does not proxy, an asynchronous job API, a streaming or binary response shape the Gateway cannot carry, or a Cloudflare capability that is not an inference call at all. When that happens:

1. The code path is marked at the call site with a clearly named, greppable annotation (for example a `NO_AI_GATEWAY` constant or a standard comment tag) that states **what** cannot use the Gateway and **why**.
2. The path is registered in a single machine-readable list in the application tier, so the UI and the documentation derive from the same source rather than drifting.
3. The exception is recorded in an explicit document in the demo root — **`AI-GATEWAY-EXCEPTIONS.md`** — with one row per exception covering: the task and route, the model or API involved, the precise reason the Gateway cannot be used, what observability is lost as a result, and whether a Cloudflare product gap should be filed.
4. The UI labels any affected run as not gateway-routed, and the request-details panel explains that cost and gateway log data are unavailable for it.
5. `AI-GATEWAY-EXCEPTIONS.md` must say so explicitly when the list is empty. An absent or stale document is itself a defect.

The goal is that a reader can answer "does everything go through AI Gateway?" in seconds, and that every exception is a deliberate, reviewed, documented decision.

## Cost metrics

Because every request is gateway-routed, the demo can show what each piece of inference actually costs. This is one of the strongest arguments for AI Gateway as a control point, so it should be a first-class feature rather than a footnote.

After a request completes, the Worker reads the log ID from `env.AI.aiGatewayLogId` and retrieves the log entry with `env.AI.gateway(<gateway-id>).getLog(logId)`. The log carries provider, model, status, duration, token usage, cache status, and **cost**.

Design rules:

- **Never block the user's response on cost retrieval.** Return the inference result first, then resolve cost. The log entry may not be immediately available, so the client should fetch it from a follow-up endpoint keyed by the run's log ID, with a short bounded retry and a graceful "cost unavailable" state.
- **Surface cost in three places:**
  - *Per run* — in the request-details section beside model, route, latency, cache status, and token usage.
  - *Per session* — a running total for the visitor's current session, broken down by task and model, so the audience can watch the number move as the demo progresses.
  - *Per task comparison* — in the history/comparison drawer, so two models for the same task can be compared on quality, latency, and cost together.
- **Show cache savings.** A cache hit should be visibly cheaper (or free) than a miss. Running the same prompt twice is a compelling, fast demonstration of why the Gateway is worth having.
- **Be honest about precision.** Cost values are reported by AI Gateway and may be rounded, delayed, zero for some models, or absent entirely. Label them as reported figures, not as a billing source of truth, and never silently display `0` when the value is actually missing.
- **Do not assume token-based pricing.** Several models in this demo are not billed per token: music generation is charged per track or per second of audio, video models by duration and resolution, and `typesafe/jev` charges for input tokens while output tokens are free. The cost display must be driven by what the gateway log reports and by each model's declared pricing unit, never by a hardcoded token calculation. Showing these different billing units side by side in the session meter is itself a worthwhile lesson.
- **Attach useful metadata.** Pass the task name, user identity, and a request ID as AI Gateway custom metadata on every run so dashboard analytics can be filtered by task during the demo. Do not put prompts or uploaded media into metadata.
- **Respect privacy.** Payload logging settings should be a conscious, documented choice for the demo rather than an accident; metadata-only logging still yields cost, tokens, and latency.
- Where a documented exception means no gateway log exists, the session total should show the run as uncosted rather than omitting it, so the gap is visible instead of invisible.

## Proposed information architecture

### Shared application shell

- **Task navigation** — a flat, single-level list of panels in a sidebar or tab bar. Headings may visually group the list into *Create*, *Understand*, *Speech*, and *Inspect*, but those headings are labels only: they are never clickable, never collapsible, and never introduce a second level of navigation. Every panel is reachable in one click from anywhere, and its route is a single segment such as `/create-image` or `/animate-image`, so panels can be linked directly.
- **Model and provider controls** — model selector, a short model description, and a gateway indicator confirming the request is gateway-routed (or flagging a documented exception). Only controls supported by the selected model should be shown.
- **Input workspace** — task-specific prompt, text, image, audio, or file controls with clear limits and supported formats.
- **Run controls** — example input, reset, run/cancel, and (for supported models) streaming output.
- **Result workspace** — an appropriate renderer for text, image, video, audio/music, labels, typed evaluation answers, or translated text, with download/copy actions.
- **Request details** — collapsible diagnostics showing request ID, model, gateway name, AI Gateway log ID, timing, status, cache hit/miss, token/media usage, and reported cost. This is where AI Gateway observability becomes concrete without cluttering the task itself.
- **Session cost meter** — always visible in the shell: a running total for the session with a breakdown by task and model, plus cached-vs-billed request counts.
- **History/comparison drawer** — recent runs retained in the browser, allowing two outputs to be compared on quality, latency, and cost without introducing a database requirement to the introductory version.
- **About/help panel** — explains that model availability, limits, and output quality vary, and links each task to the relevant Workers AI model documentation.

A persistent **Overview** tab can show the task cards, a short explanation of Workers AI and AI Gateway, and a “Try an example” action for each task. A separate **Activity / Gateway** tab can show recent request summaries, latency, cache status, errors, cost, and aggregate usage, together with a link to the gateway in the Cloudflare dashboard and a visible statement of the mandatory-gateway policy and its current exceptions. It should never display secrets or full user prompts by default.

## Task panels

### Naming and nesting rules

Panels are **flat and plainly named**. There is exactly one level of navigation: every panel is a top-level destination with its own route, and no panel contains sub-modes, nested tabs, or a secondary task hidden inside it.

Panel names say **what the panel does**, in verb–object form, using the words a visitor would use. They are not product names. There are no "studios", "labs", or "workbenches" in this application — a name like *Motion Studio → Animate* forces the reader to learn an invented brand and then find the real task inside it, which is exactly the overhead a playground should not have. *Animate Image* needs no explanation at all.

Two panels may share components, job handling, or an API shape. That is an implementation detail and never a reason to merge them into one tab with a mode switch: **share code, not tabs**.

The technical task type stays visible as a subtitle and in the request details, so the panel teaches the vocabulary (`image-to-video`, `automatic speech recognition`) without making the visitor decode it to find the feature.

### Panel list

| Panel | Task type | Input and controls | Result and learning goal | Potential existing reference |
| --- | --- | --- | --- | --- |
| **Chat** | Text generation | Prompt and system-instruction fields, model selector, max tokens, temperature, top-p, and stop sequences only when supported. Streaming output with a token/latency summary. | Streaming completion with copy, regenerate, and “show request” controls. Conversation stays lightweight — a model probe with turn history, not a second chat product; the [`ai-chat` demo](../../../../cf-demos/demos/ai-chat/README.md) owns that role. | [Cloudflare AI Playground](https://playground.ai.cloudflare.com/) and [Google AI Studio](https://aistudio.google.com/). |
| **Create Image** | Text-to-image | A positive prompt, optional negative prompt, model selector, aspect ratio/size, seed, and number of steps where supported. Include prompt examples and a gallery-style result area. | Render one or more generated images with prompt, model, seed, and download controls. Demonstrates generative media, binary responses, and model-specific parameters. | [Cloudflare Workers AI image-generation playground tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/image-generation-playground/) and the [Cloudflare AI Playground](https://playground.ai.cloudflare.com/). |
| **Describe Image** | Image-to-text | Image upload, paste-from-clipboard, or image URL where safe; optional question or instruction such as “describe this image” or “what text is visible?”. | Stream or display a textual description/answer, with an image preview beside it. Demonstrates multimodal inference and the distinction between an image input and a text generation output. | [Hugging Face image-to-text task](https://huggingface.co/tasks/image-to-text) and the multimodal experience in [Cloudflare's AI Playground](https://playground.ai.cloudflare.com/). |
| **Remix Image** | Image-to-image | Source reference image plus a preservation-aware editing instruction and optional seed where supported. Use a whole-image reference-editing model; masked inpainting is a different interaction and must not be simulated with a full-image mask. | Accessible before/after comparison of the current source and result. Demonstrates reference-image editing while making subject/composition preservation explicit. | [Hugging Face image-to-image task](https://huggingface.co/tasks/image-to-image) and [FLUX.2 Klein 4B](https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/), [FLUX.2 Klein 9B](https://developers.cloudflare.com/workers-ai/models/flux-2-klein-9b/), [FLUX.2 Dev](https://developers.cloudflare.com/workers-ai/models/flux-2-dev/), [P-Image-Edit](https://developers.cloudflare.com/ai/models/pruna/p-image-edit/), and [Nano Banana 2](https://developers.cloudflare.com/ai/models/google/nano-banana-2/). |
| **Classify Image** | Image classification | Image upload or camera/paste input, model selector, and top-k/confidence threshold controls. | Ranked labels with confidence bars and the original image. Demonstrates structured JSON output, confidence interpretation, and a non-generative model. | [Hugging Face image-classification task](https://huggingface.co/tasks/image-classification). |
| **Create Video** | Text-to-video | Text prompt, duration/aspect-ratio controls when supported, and an explicit notice that generation may be asynchronous and slower than other tasks. | Video player with progress state, poster frame, download, and request status. Demonstrates long-running generation, polling or streaming status, and large media output. | [Hugging Face text-to-video task](https://huggingface.co/tasks/text-to-video) and [Replicate's model playground](https://replicate.com/playground). |
| **Animate Image** | Image-to-video | Source image upload plus an optional motion prompt; resolution (720p/1080p) and duration controls where supported. Models include `alibaba/wan-2.7-i2v` and `alibaba/hh1.1-i2v`. | Side-by-side still image and resulting video, with duration, resolution, download, and job status. Demonstrates animating a fixed subject and the cost difference between a still and a moving output. | [Wan 2.7 I2V](https://developers.cloudflare.com/ai/models/alibaba/wan-2.7-i2v/) and [Runway's image-to-video tools](https://runwayml.com/). |
| **Generate Music** | Music generation | Style/mood prompt, instrumental toggle, optional lyrics, track length, and output format. Models include `elevenlabs/music-v2` and `minimax/music-2.6`. | Audio player with track length, lyrics display when present, download, and per-track cost. Demonstrates a distinctly non-token pricing model and a long-form creative output. | [ElevenLabs Music](https://elevenlabs.io/music), [Suno](https://suno.com/), and [MiniMax Music 2.6](https://developers.cloudflare.com/ai/models/minimax/music-2.6/). |
| **Read Text** | Text-to-speech | Text area, voice, language, speaking rate/pitch where supported, and an accessible text alternative. | Audio player with waveform or duration, download action, and optional transcript display. Demonstrates binary/audio output, playback, and a model capability that is not naturally represented as text. | [Google Cloud Text-to-Speech](https://cloud.google.com/text-to-speech) and [Azure AI Speech Studio](https://speech.microsoft.com/portal). |
| **Transcribe Audio** | Automatic speech recognition (speech-to-text) | Audio upload or microphone recording, language hint, timestamps/diarization options where supported, and a clear recording permission state. | Transcript with copy/download, timestamp segments, and confidence information when available. Demonstrates audio input, potentially asynchronous processing, and the speech-to-text terminology users are likely to search for. | [Hugging Face automatic-speech-recognition task](https://huggingface.co/tasks/automatic-speech-recognition) and [Azure AI Speech Studio](https://speech.microsoft.com/portal). |
| **Translate Text** | Translation | Source language, target language, text area, and swap-languages action. Include sample phrases and preserve line breaks in the output. | Side-by-side source and translated text, with copy and optionally a handoff to Read Text. Demonstrates task-specific model inputs and multilingual output. | [Hugging Face translation task](https://huggingface.co/tasks/translation) and [Google Cloud Translation demo](https://cloud.google.com/translate). |
| **Classify Text** | Text classification | Text area, optional label set or task mode (for example sentiment, emotion, or topic), and a few pre-filled examples. | Label/confidence visualization and raw structured response in an expandable section. Demonstrates fast, deterministic-feeling inference and the difference between classification and free-form generation. | [Hugging Face text-classification task](https://huggingface.co/tasks/text-classification). |
| **Evaluate Choices** (see below) | Structured evaluation | A state (free text or structured JSON) plus a set of typed questions — `noul`, `choice`, and `score` — each with instructions and criteria. Built on `typesafe/jev`. | Per-question answers with probabilities and calibrated confidence, rendered as gauges and probability bars rather than prose. Demonstrates classification, routing, and judgement as a typed API contract instead of parsed free text. | [Jev model reference](https://developers.cloudflare.com/ai/models/typesafe/jev/) and LLM-as-judge/eval tooling such as [Braintrust](https://www.braintrust.dev/) or [OpenAI Evals](https://github.com/openai/evals). |
| **Semantic Search** (see below) | Text embeddings | A query plus a small editable collection of example passages; model selector (for example `@cf/baai/bge-m3` or `@cf/qwen/qwen3-embedding-0.6b`), optional similarity metric, and a run action. Provide prepared collections such as product documentation, support questions, or short facts. | Ranked passages with similarity scores, plus an inspectable vector summary. Demonstrates that embeddings represent semantic similarity rather than generating prose, and teaches the retrieval step that underpins semantic search and RAG. | [Hugging Face feature-extraction task](https://huggingface.co/tasks/feature-extraction), [Pinecone's semantic search examples](https://docs.pinecone.io/guides/search/semantic-search), and the [Workers AI embedding model catalog](https://developers.cloudflare.com/workers-ai/models/). |
| **View Tokens** (see below) | Tokenization (no inference) | Free-text prompt plus a tokenizer/model selector; options to toggle whitespace and special-token display, and to switch between token and character views. | Prompt re-rendered as colored token boxes with a token count, character count, and an inspectable token/ID list. Demonstrates what a model actually reads, and makes context limits and token-based pricing tangible. | [OpenAI Tokenizer](https://platform.openai.com/tokenizer), [Tiktokenizer](https://tiktokenizer.vercel.app/), and the Gemini [token visualization](https://glaforge.dev/img/gemini/token-viz.jpg) style. |

Any panel above whose model or response shape turns out not to be gateway-routable — the long-running video and music jobs are the most likely candidates — must be recorded in `AI-GATEWAY-EXCEPTIONS.md` and labelled in the UI, rather than quietly bypassing the Gateway.

### Evaluate Choices (structured evaluation with Jev)

`typesafe/jev` is catalogued as a text-generation model, but using it through Chat would misrepresent it badly. It does not take a prompt and return prose. It takes a **state** and a set of **typed questions**, and returns calibrated answers with probabilities — so it deserves a panel whose entire shape is different from the other text panels.

> **NOTE**: Cloudflare will be releasing "clef" - a similar model to typesafe/jev, but running at the edge.  This is due to be released within a week so we should double-check at the point of implementation to see if it is available.

The lesson this panel teaches is one the rest of the demo cannot: not every language-model task is generation. Here the output is a typed contract, there is no free text to parse, no JSON-mode coaxing, no schema prompt-engineering, and no "please respond only with valid JSON" incantation. The model answers exactly the questions asked, in the shape they were asked.

**Input design**:

- A **state** editor accepting either free text (a support message, a review, a transcript) or structured JSON (a ticket together with the order and policy it should be judged against). Structured state is the more interesting case because question instructions can reference fields by name.
- A **question builder** — the heart of the panel — where each question has a key, a type, instructions, and criteria:
  - `noul` — a truth-valued judgement returning a probability rather than a hard boolean. Criteria describe what true and false look like.
  - `choice` — selection from named options, each with a description, returning the chosen option plus a probability for every option.
  - `score` — a graded rating over an ordered legend, returning a continuous score, a confidence, and a probability distribution across the legend.
- Add, remove, reorder, and edit questions, since asking several questions about one state in a single call is the model's defining characteristic.
- A raw JSON view of the request, synchronized with the builder, so a developer can see exactly what the typed contract looks like on the wire.
- Prepared scenarios that show the model doing real work: support triage (urgency, department, frustration), refund eligibility against a policy, content moderation, and lead qualification.

**Result design**:

- One result card per question, rendered by type: a probability bar for `noul`, ranked probability bars with the winner marked for `choice`, and a gauge positioned on the labelled legend for `score`.
- Always show **confidence separately from the answer**. A confident wrong answer and an unconfident right one look identical in prose output and completely different here — that contrast is the point.
- Never round a probability away into a bare yes/no. Showing `0.95` rather than "yes" is what distinguishes this panel from Classify Text.
- Offer a comparison mode that runs the same questions against a varied state, so a visitor can watch probabilities move as the input changes.
- Show the typed JSON response alongside the visual rendering.

**Positioning and cost**:

- Keep Evaluate Choices clearly distinct from **Classify Text**. Classification applies one label set from a fixed model; Evaluate Choices asks arbitrary caller-defined typed questions, with criteria supplied at request time, and returns calibrated probabilities for each. The panels should cross-reference each other and state the difference plainly.
- Like everything else, Jev runs through the shared gateway helper and reports its gateway log, latency, token usage, and cost. Its asymmetric pricing — priced input, free output — is a genuinely interesting cost-model contrast to put beside a generative panel, and the session cost meter will show it.
- Note in the UI that the model has a 32,000-token context window, and that a large structured state consumes it quickly. Showing the state's token count here, borrowed from View Tokens, ties the two panels together neatly.

### Generate Music

Music generation is the clearest demonstration in the whole Playground that AI output is not always text or images, and that **pricing is not always per token**. Candidate models are `elevenlabs/music-v2` (priced per second of output audio) and `minimax/music-2.6` (priced per track, with a separate charge for lyrics generation).

- Inputs: a style/mood prompt, an instrumental toggle, optional user-supplied lyrics, track length, and output format where the model supports it. Provide prompt examples across genres, since a vague prompt produces a forgettable result and a specific one is a far better demo.
- Results: an audio player with track length and waveform, the lyrics used when applicable, a download action, and the reported cost for that track.
- These models return a **URL to an audio asset** rather than inline audio bytes. The panel must handle that response shape explicitly, and should state plainly that generated assets are hosted by the provider and may expire — a real operational consideration rather than an incidental detail.
- Generation takes noticeably longer than a text completion. Show honest progress state and keep the request cancellable; never leave the panel looking frozen.
- The cost contrast is the teaching moment. Put a per-track or per-second charge beside a per-token one in the session cost meter and the difference in billing model becomes obvious at a glance.

### Animate Image

**Animate Image** is a top-level panel in its own right, not a mode inside Create Video. The two share a video player, job-status handling, and progress/cancellation behaviour, but a visitor arriving with a picture should find a panel named for what they want to do rather than discovering it inside a video-generation tab. Share the implementation; do not share the tab. Candidate models include `alibaba/wan-2.7-i2v` and `alibaba/hh1.1-i2v`, both supporting 720p/1080p output and durations of roughly 2–15 seconds.

- Inputs: a source image, an optional motion prompt describing what should happen, and duration/resolution controls where supported.
- Results: the still image and the resulting video shown together, so the relationship between input and output is immediately legible. Include duration, resolution, download, and cost.
- The natural demo chain is **Create Image → Animate Image**: generate a picture, then bring it to life. Offer that handoff directly, as it is the single most memorable sequence available in this application.
- Like Create Video, generation is slow and potentially asynchronous. Both panels share the same job-status, polling, cancellation, and progress handling, and both must record an `AI-GATEWAY-EXCEPTIONS.md` entry if any part of that flow cannot traverse the Gateway.

### Semantic Search

Text embeddings are a first-class AI task and every embedding request goes through AI Gateway. Candidate Workers AI models include **`@cf/baai/bge-m3`** and **`@cf/qwen/qwen3-embedding-0.6b`**; the final model list must come from the current Workers AI catalog and the model descriptors must state their vector dimensions, supported input shape, and context limits.

This panel makes vectors useful instead of showing visitors an unexplained wall of floating-point values. The visitor enters a query and searches a deliberately small, editable collection of passages. The Worker embeds the query and passages through the shared gateway inference helper, calculates a declared similarity measure — cosine similarity is the recommended default — and returns the collection ranked by semantic relevance. A result should make the learning moment obvious: text with different words but the same meaning ranks above text sharing words but discussing something else.

**Controls and results**:

- Start with curated collections of five to twenty short passages, such as Cloudflare product documentation, support questions, recipes, or travel notes. Let the visitor switch collections, edit an item, add an item, and replace the query.
- Show ranked cards with the similarity score, rank, and a concise explanation that scores are relative to the selected collection and model — not probabilities or factual confidence.
- Include a "why did this rank?" comparison view that highlights shared concepts in plain language. It must not falsely claim that individual vector dimensions have human-readable meanings.
- Provide an expandable, truncated vector view showing dimension count, magnitude, and a small leading slice of values. Make the full raw vector available only on demand, since it is implementation detail rather than the primary lesson.
- Let the visitor run the same collection against another embedding model and compare rank changes, latency, vector dimensionality, and AI Gateway-reported cost.
- Cache embeddings using a stable content-derived key. When a passage is unchanged, reuse its cached embedding and visibly indicate the cache hit; only the edited passage and new query should need inference.

**Gateway and cost behaviour**:

- Embedding calls use the shared `env.AI.run(..., { gateway: { id } })` helper just like generative calls. They receive a gateway log ID and participate in per-run details, the session cost meter, caching indicators, and task/model cost comparison.
- The logical "search" action may issue more than one inference request — one for the query and one or more for collection passages. The UI should show an **aggregate search cost** as well as the individual gateway log entries that comprise it. Do not misleadingly present the query's cost as the cost of embedding the collection.
- Similarity calculation is local application logic, not an AI request. It is free from the Gateway's perspective and should be labelled accordingly.
- This introductory panel deliberately uses an in-memory collection and direct vector comparison. It teaches embeddings and retrieval without requiring a database or Vectorize. A later, distinct demo can extend the same flow with Vectorize and durable indexing.

### View Tokens

**View Tokens** is a visual aid rather than a model task. As the visitor types a prompt, the panel re-renders that prompt as a sequence of **colored token boxes**, so a reader can see exactly how the text is split before a model ever sees it. The reference look is the familiar tokenizer visualization — contiguous, tightly packed boxes that preserve the original text's reading order, each token tinted from a small repeating palette so adjacent boxes are easy to tell apart.

Why it belongs in this demo: every other panel reports token counts and token-driven costs, and this panel is what makes those numbers intelligible. It answers "why did that short prompt cost more than this long one?", "why does the model keep miscounting letters?", and "how close am I to the context window?" in a way a number alone cannot.

**Behaviour**:

- Tokenize as the user types, debounced, with no round trip per keystroke once the tokenizer is loaded.
- Show a live summary: token count, character count, and characters-per-token. Where the selected model's context window is known, show tokens used as a proportion of that window.
- Offer three synchronized views of the same result: the colored boxes, the plain text, and a table of index, token string, and token ID.
- Hovering or focusing a token highlights it, and reveals its index, ID, and an escaped rendering of its exact text.
- Render whitespace and newlines visibly — a leading space is part of a token and is one of the most instructive details in the whole panel. Provide a toggle between a visible-whitespace glyph and literal rendering.
- Mark special/control tokens distinctly from ordinary ones, since they are added by the template rather than typed by the user.
- Include a few prepared examples that teach something specific: a word split into several tokens, numbers and dates, an emoji, a non-Latin script, whitespace runs, and a code snippet. Non-English and code examples make tokenizer differences obvious.
- Let the visitor compare two tokenizers on the same input side by side, with both counts shown. Comparing a small model to a frontier model on the same paragraph is an effective demo moment.
- Offer a handoff to Chat so a prompt being inspected can be run immediately, and a reverse handoff so a prompt from Chat can be inspected.

**Accessibility and rendering**:

- Color alone must not carry meaning. Token boundaries must remain visible through spacing/outline, and each token needs an accessible label.
- The palette must maintain sufficient contrast against token text in both light and dark themes.
- The box sequence must remain readable as text: selecting across tokens should yield the original prompt, not a jumble of separated fragments.
- Long inputs should be virtualized or truncated with a clear notice rather than rendering tens of thousands of boxes.

**Implementation note and gateway policy**:

Tokenization is *not* an inference call, so it does not go through AI Gateway and it does not produce an AI Gateway log or cost. That is not a Gateway limitation and it must not be presented as one. Accordingly:

- View Tokens is **out of scope** for `AI-GATEWAY-EXCEPTIONS.md`, which records only genuine *inference* paths that bypass the Gateway. The panel's own UI should state plainly that no inference occurs here, so nobody reads the absent cost figure as a missing feature.
- It contributes nothing to the session cost meter, and the meter should not show it as an uncosted run.
- Workers AI exposes no tokenizer endpoint, so the demo supplies the tokenizer itself. Prefer running the tokenizer in the browser so keystrokes never leave the page; if a bundle is too large for that, expose a narrow Worker route and document the trade-off. Either way, prompts must not be logged.
- Token counts are tokenizer-specific. Label each count with the tokenizer that produced it, and state clearly when the selected chat model's exact tokenizer is unavailable and a close approximation is being shown. An honest approximation beats a confidently wrong number.

The references are inspiration for interaction patterns, not a requirement to reproduce their branding or exact behavior. Cloudflare's own [multi-modal playground](https://multi-modal.ai.cloudflare.com/) is especially useful for studying how several modalities can coexist in one application, while the [Workers AI model catalog](https://developers.cloudflare.com/workers-ai/models/) should remain the source of truth for models and task support.

## Demonstration narrative

A presenter should be able to start at Overview and follow a coherent path:

1. Run a text-generation request and show the model response streaming through the shared API.
2. Open the request details and show the AI Gateway log ID, latency, tokens, and reported cost appearing for that run.
3. Re-run the identical prompt and show the cache hit — faster, and cheaper or free — then show the session cost meter reflecting both runs.
4. Open View Tokens with that same prompt and show it broken into colored token boxes, connecting the token count on screen to the cost just reported.
5. Use Semantic Search to embed a query and small passage collection, then explain why the differently worded but semantically similar result ranked first. Show the aggregate cost, including the query and passage embeddings.
6. Open Evaluate Choices with a support ticket and ask three typed questions at once. Show the calibrated probabilities and confidence, and make the point that no JSON parsing or schema prompting was involved.
7. Generate an image, then use Image-to-text to ask a vision model to describe it, noting the cost difference between modalities.
8. Send that same generated image to Animate Image and bring it to life, showing the still and the resulting video together.
9. Generate a short instrumental track in Generate Music, then point at the session cost meter: per-token, per-second, and per-track charges now sit side by side.
10. Translate a phrase in Translate Text and send it to Read Text, demonstrating that one result can become another panel's input.
11. Finish on Activity / Gateway with the session total, per-task cost breakdown, and the same traffic visible in the Cloudflare AI Gateway dashboard — the point being that one control point covered every modality in the demo.

These handoffs should be optional conveniences, not hidden coupling between panels. Every panel must also work independently with an uploaded or example input.

## Scope boundaries for the first specification

- The first version should prioritize a small, reliable set of representative models over exposing every model in the catalog.
- Model metadata and supported controls should be data-driven, so adding a model does not require rewriting every panel. Each descriptor must declare its task type, input/output shape, and **pricing unit**, since the catalog mixes per-token, per-second, per-track, and per-video billing.
- Several of these tasks — music, video, image-to-video, and `typesafe/jev` — are third-party models reached through Unified Billing rather than Cloudflare-hosted Workers AI models. The demo should label which is which, and the README must note that third-party models require AI Gateway and consume account credits.
- Every model offered must be gateway-routable, unless its exception is documented in `AI-GATEWAY-EXCEPTIONS.md` and surfaced in the UI.
- Cost display is a required feature of the first version, not a later enhancement. Per-run cost, session total, and cache savings all ship together. A multi-request operation such as semantic search must also show its aggregate cost.
- Gateway diagnostics should be useful but privacy-preserving: do not persist or display prompts, uploaded media, audio, or generated content in analytics by default.
- Authentication, quotas, file-size limits, content-type validation, cancellation, and friendly provider errors are part of the product design even if the initial visual prototype uses mocked responses.
- The shared Worker should expose narrow task-oriented API routes rather than allowing the browser to call provider APIs directly. This keeps credentials and routing server-side and gives AI Gateway one consistent integration point.
- The browser never talks to Workers AI or any provider directly. Doing so would bypass the Gateway and defeat the point of the demo. View Tokens is the one panel with no inference behind it, and it must say so rather than appearing to be an exception to this rule.
- Panels stay flat. If a future capability seems to want a sub-tab, it is a new top-level panel with its own plain name, sharing implementation with its sibling rather than hiding inside it.
