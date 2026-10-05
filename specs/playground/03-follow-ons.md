# Follow on Requirements

> **Status:** reviewed against the codebase and the live model catalogue on 2026-10-05. Items 1–3
> are approved for implementation with the decisions recorded below. Item 4 is **not** approved as
> written; it becomes a spike first, then a scoped implementation phase. See
> [Item 4](#4-include-all-cloudflare-hosted-models) for why.
>
> Each item below keeps its original requirement text, followed by a **Review** section recording
> what the codebase actually looks like, and a **Decisions** section recording what was agreed.
> Where the original text was factually wrong about the current state, that is called out rather
> than silently corrected — the wrong assumption is itself useful to the implementer.

## 1. Make the task types collapsible

Currently, the sidebar has headings "Generate", "Understand", "Speech", "Reason", and "Inspect".
These should be made into collapsible sections, with the default state that everything is expanded.
Include a "collapse all" and "expand all" icon pair at the top of the lists for easy management.

### Review

Feasible and self-contained. The work lands almost entirely in
`src/client/components/shell/PanelNavigation.vue`.

**This reverses a decision the demo currently documents in three places**, and all three have to
change in the same commit or the codebase starts contradicting itself:

- `src/shared/tasks.ts` — the `TaskGroup` doc comment: _"Groups are labels, never navigation. They
  do not expand, collapse, filter, or route… The navigation stays exactly one level deep."_
- `src/client/components/shell/PanelNavigation.vue` — the template comment: _"deliberately not a
  `v-list-subheader` button or an expansion panel… without becoming something that can be clicked,
  focused, or collapsed."_
- `tests/client/components/PanelNavigation.test.ts` — the test
  **`renders group labels as headings, not controls`**, which asserts a group heading has no `role`,
  no `tabindex`, and contains no `button` and no `a`.

That test was written specifically to prevent this change. It failing is the expected and correct
outcome; it must be rewritten to assert the _new_ contract rather than deleted, so the navigation
still has a pinned shape.

### Decisions

- **Approved**, accepting the reversal knowingly.
- Rewrite, do not delete, the `renders group labels as headings, not controls` test. The replacement
  should assert the disclosure contract: a real `<button>`, correct `aria-expanded` tracking the
  open state, and `aria-controls` pointing at the list it governs.
- Update all three "never collapsible" comments in the same commit. A stale comment that contradicts
  the code is worse than no comment.
- **Default state is fully expanded**, as specified. Consider persisting the collapsed set to
  `localStorage` so a presenter who collapses groups does not have them spring back on reload — but
  a collapsed group must never be the reason a panel cannot be found. The expand-all control is the
  escape hatch and should be obvious.
- The heading must remain a heading for screen-reader navigation. Use a `<button>` **inside** the
  `<h2>` rather than replacing the `<h2>` with a `<button>`; replacing it removes the panel list
  from heading navigation entirely.
- The phase 18 cross-panel accessibility contract (`tests/client/accessibility-contract.test.ts`)
  does not yet cover disclosures. Extend it, or accept that this disclosure is covered only by its
  own component test.

## 2. Indicate Cloudflare-hosted and Third-Party models

Each task type has a mix of cloudflare-hosted models and third-party models. The third-party models
require AI credits to be added to the account. Additionally, as we were developing, we included a
"phase" number pill next to the task type.

Replace the phase number pill with a set of icons. Use the cloudflare logo for a task type that
allows cloudflare-hosted models and a "3P" icon for a task type that has third-party models
available. Display these logos where the phase number pull used to be.

### Review

**The phase pill does not currently render anywhere.** It is conditional on
`task.availability === 'planned'`, and after phase 18 every one of the sixteen panels is
`'available'`. Two existing tests assert this state
(`has no phase label when every listed panel is delivered` and
`badges exactly the panels that are not built yet`).

This does not change the goal — it changes the framing. The badge _slot_ in the markup is the target
location, and the phase-pill logic occupying it is now dead code.

**The hosting data is not currently available to the sidebar.** `TaskDescriptor` has no notion of
hosting; that lives in `MODEL_DESCRIPTORS` in the Worker's domain tier, which deliberately never
reaches the browser except through `/api/catalogue`. `PanelNavigation.vue` renders from the static
`TASK_DESCRIPTORS` import and makes no API call. Making the sidebar API-dependent would mean
navigation that cannot render until a fetch resolves, which is a bad trade for a decorative badge.

Useful finding: `CatalogueModel` already exposes `provider` to the browser, with exactly two values
across the 36 descriptors — `'workers-ai'` (28) and `'third-party'` (8). The data exists; it is the
_sidebar's_ access to it that does not.

### Decisions

- **Approved.** Use the badge slot as the location, and remove the completed-only prototype
  machinery in full — not merely the visible phase pill. Every task is now delivered, and future
  tasks arrive as complete check-ins rather than placeholders, so this state is permanently
  unexercised.
  - Remove `TaskAvailability`, `TaskDescriptor.availability`, and `TaskDescriptor.phase` from
    `src/shared/tasks.ts`, including the explanatory comments and every descriptor's values.
  - Delete `PlannedPanelView.vue`, remove its router import, and replace
    `DELIVERED_VIEWS[task.id] ?? PlannedPanelView` with a direct delivered-view mapping. A task
    without a view is now a programming error that TypeScript and a route-coverage test should
    catch, not a visitor-facing phase placeholder.
  - Delete the phase-pill markup and styles in `PanelNavigation.vue`, plus every phase/availability
    test: `has no phase label when every listed panel is delivered`,
    `does not label a delivered panel with a phase`, and
    `badges exactly the panels that are not built yet`.
  - Remove any documentation still presenting a "planned" panel as a supported application state.
    The complete catalogue is now the product contract, not a progress indicator.
- **Show both icons where both apply.** A panel offering Cloudflare-hosted _and_ third-party models
  gets the Cloudflare mark and the 3P mark. The pair is the information: it says "this works
  unfunded, and it also has paid options to compare against". This supersedes the single-flag
  suggestion raised in review — the explicitness is the point.
- **Cloudflare logo usage is approved** for this purpose; no trademark question remains open.
- **Derive the hosting facts at build time, not via an API call.** Add a computed field to the task
  catalogue (or a small derived map) so `PanelNavigation.vue` stays synchronous and dependency-free.
  A test should assert the derived flags match what `modelsForTask()` actually returns, so the badge
  cannot drift from the model registry.
- **Both icons need text alternatives.** The outgoing pill was text and therefore never had this
  problem; a bare logo and a bare "3P" glyph both do. Each needs an accessible name along the lines
  of "Cloudflare-hosted models available" and "third-party models available (requires AI credits)".
  A `title` attribute alone is not sufficient.
- Three panels have **no** hosted option at all — Create Video, Animate Image, Generate Music — and
  will therefore show only the 3P mark. That is the presenter-critical case the badges exist to make
  visible, and it should be checked explicitly in a test.

## 3. Document model ID

Each model is represented by its descriptive name; however, cloudflare uses a model ID instead. In
all the model drop-downs, we should provide both. For example, in Chat, we currently show "Llama 3.3
70B (fast)", which has a model ID of `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. We should show this
as `Llama 3.3 70B (@cf/meta/llama-3.3-70b-instruct-fp8-fast)` in the model list.

### Review

Mechanically easy: `CatalogueModel.id` already reaches the browser. The selector markup is
duplicated across **fourteen** places — thirteen views using
`<option v-for="candidate in models">{{ candidate.name }}</option>`, plus `ChatComposer.vue` with
the same pattern. Any format change has to be made consistently in all fourteen, which is an
argument for extracting a shared model-selector component as part of this work rather than editing
fourteen templates.

Two problems with the literal format proposed:

- **Length.** `Llama 3.3 70B (@cf/meta/llama-3.3-70b-instruct-fp8-fast)` is 56 characters. A native
  `<option>` cannot be styled or wrapped, so in the 44rem panel column this truncates on narrower
  viewports — and truncation from the right hides the ID's distinguishing tail, which is the part
  worth showing.
- **Suffix collision.** Two models already carry a `(beta)` suffix in their display name, which
  would produce `Stable Diffusion XL (beta) (@cf/stabilityai/stable-diffusion-xl-base-1.0)`.

### Decisions

- **Keep dropdown options as descriptive names only.** Native `<option>` elements cannot wrap or be
  styled reliably, and adding an ID makes their meaningful tail truncate first on a narrow panel.
  The selector stays readable; the settings block supplies the technical identifier.
- **Show the full, unmodified model ID in the model settings block.** Do not strip `@cf/`: it is
  part of the value a visitor copies into `cf ai run`, and omitting it risks teaching a subtly wrong
  identifier. `ModelSettingsPanel.vue` already has room in its expanded body for a full, selectable,
  copyable ID, which gives the value somewhere it can be read properly.
- **The displayed ID must react to selection.** Every `v-model` update in a dropdown must update the
  ID in the settings block immediately, from the same `selectedModel` lookup that currently updates
  controls. Test the change explicitly with at least two models: selecting the second must replace
  the first ID rather than leave a stale summary behind. The contract is not merely "the model ID
  appears"; it is "the model ID identifies the active model."
- **Decision changed: drop the `(beta)` tag from all model display names.** Catalogue models move
  between beta and GA frequently in both directions, so a marker baked into a display name is a
  claim the repository cannot keep current — it will be wrong some of the time, and a stale
  stability claim is worse than none. This reverses the phase 18 convention deliberately.
  - Remove `(beta)` from `Stable Diffusion XL (beta)`, `LLaVA 1.5 7B (beta)`, and
    `EmbeddingGemma 300M (beta)`.
  - Remove the phase 18 test `marks a beta model in its display name, consistently` in
    `tests/worker/domain/models.test.ts`. Replace it with a guard asserting **no** descriptor name
    contains a stability marker, so the convention cannot creep back in one model at a time.
  - Record the reversal and its reasoning in the phase 18 notes in `02-implementation.md`, next to
    the descriptor-reconciliation entry that introduced the convention. The earlier decision was
    correct given what was known; it is being replaced because the maintenance cost is now clear.
  - This also removes the suffix collision, so the ID is the only parenthetical in a model name.

## 4. Include all Cloudflare Hosted Models

We have made a deliberate decision to limit the number of models available in the demo. However,
there is a benefit to being able to use all Cloudflare-hosted models for a specific task type. For
each task type:

- Determine the list of cloudflare-hosted models that can handle the task.
- Use `cf ai run` to determine the schema shape of the model.
- Add each cloudflare-hosted model to the list of available models for the task.
- If additional work is needed to support the model, then do that work.

Summarize the work done on a per-task basis at the end of the turn.

### Decision: spike first

**This item is not approved for direct implementation.** It is the highest-risk of the four, and the
risk is not effort — it is that a faithful implementation would make the demo _worse_ in ways that
are not obvious until the models are actually called.

The agreed approach is a **time-boxed spike** that probes the candidate models, classifies them, and
produces an include/exclude recommendation. Implementation is a separate decision taken after
reading the spike's findings.

### Review: the scope is roughly four times what the text implies

Measured against the live catalogue on 2026-10-05 (`cf ai models list`, 69 models over ten task
types), against the 27 distinct Cloudflare-hosted model identifiers currently registered:

| Catalogue task type          | Registered | Available | Missing |
| ---------------------------- | ---------: | --------: | ------: |
| Text Generation              |          6 |        35 |  **29** |
| Text Embeddings              |          3 |         7 |       4 |
| Text-to-Image                |          5 |        10 |       5 |
| Automatic Speech Recognition |          3 |         5 |       2 |
| Text-to-Speech               |          3 |         4 |       1 |
| Dumb Pipe                    |          0 |         1 |       1 |
| Image Classification         |          1 |         1 |       0 |
| Image-to-Text                |          2 |         2 |       0 |
| Text Classification          |          2 |         2 |       0 |
| Translation                  |          2 |         2 |       0 |
| **Total**                    |     **27** |    **69** |  **42** |

**42 new descriptors.** `src/worker/domain/models.ts` is already 1,804 lines for 36 descriptors
covering 27 distinct hosted identifiers (one model is registered twice under different panels) plus
8 third-party ones.

Per-model cost is not uniform and this is easy to underestimate. A Chat descriptor is about ten
lines. A Create Image descriptor needs verified control ranges — `steps` minimum, maximum and
default, whether `seed` and `negative_prompt` exist at all, and whether the model rejects undeclared
parameters — each of which is a separate live probe, because the catalog page is not always right.
The existing FLUX.1 schnell descriptor carries the comment _"despite the example on its own catalog
page — no seed"_, which is precisely that lesson already learned once.

### Concern 1 — reasoning models would visibly break Chat

This is the most serious finding and it is confirmed, not theoretical. Probed live:

`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` returns its chain-of-thought inline in the same field
the panel renders:

```json
{
  "response": "<think>\nOkay, so the user asked me to say \"hi\" in three words. Hmm, let me break this down…"
}
```

`@cf/openai/gpt-oss-120b` has the same problem in a different shape — an OpenAI-style envelope with
the answer in `choices[0].message.content` and the monologue in a sibling `reasoning` field:

```json
{
  "choices": [
    {
      "message": {
        "content": "Hello there friend",
        "reasoning": "The user says: \"Say hi in 3 words\"…"
      }
    }
  ]
}
```

`parseStreamChunk` in `gateway-inference-client.ts` reads `response` and `choices[0].delta.content`.
For the DeepSeek shape it would pass the `<think>` block straight through, so **a visitor would
watch the model's raw internal monologue stream into the transcript** in the demo's flagship panel.
Adding these models without handling reasoning output is a visible defect, not a cosmetic one.

Supporting them properly means deciding what reasoning output _is_ in this demo: hidden, shown in a
disclosure, or a reason to exclude the model. That is a product decision with real UI work behind
it, and it is not implied anywhere in the item's four bullets.

### Concern 2 — input schemas genuinely differ

`@cf/openai/gpt-oss-120b` accepts four mutually exclusive input shapes. Its validator reports:

```
oneOf at '/' not met: required properties are 'prompt', or 'messages',
or 'input', or 'requests'
```

The demo sends `messages`, which is among them — but "among them" has to be verified per model
rather than assumed, and the _output_ envelope differs even when the input matches. The streaming
parser already tolerates two shapes; a third would need adding deliberately, with a test.

### Concern 3 — some models do not map to any panel

- **`@cf/pipecat-ai/smart-turn-v2`** is task type **"Dumb Pipe"**. It detects conversational
  turn-taking in audio. There is no panel for it, and creating one is far outside "add models to
  existing task types". It should be excluded with the reason recorded.
- **Five LoRA adapters** (`@cf/google/gemma-2b-it-lora`, `@cf/google/gemma-7b-it-lora`,
  `@cf/meta-llama/llama-2-7b-chat-hf-lora`, `@cf/mistral/mistral-7b-instruct-v0.2-lora`, and others
  flagged `lora` in the catalogue) are fine-tuning base models rather than models a visitor would
  meaningfully pick from a dropdown. Including them adds dropdown noise and invites a confusing
  comparison.
- **`@cf/runwayml/stable-diffusion-v1-5-inpainting`** is an inpainting model: it needs a mask input
  the Create Image panel has no concept of. It belongs to a feature that does not exist.

The item's instruction to add _every_ hosted model per task type has no answer for any of these.

### Concern 4 — it contradicts the demo's stated thesis

`models.ts` records the curation rationale explicitly: two Chat models _"because having something to
compare is what makes the cost meter interesting: the same prompt against a 70B and a 3B model
produces visibly different latency and a materially different figure in the session total."_

The demo's argument is for **reviewed, understood model choices**. A 35-entry Chat dropdown — in
which several entries are LoRA adapters and at least two leak chain-of-thought — is a weaker
teaching artifact than six curated ones, and it erodes the word "reviewed" that the architecture
tests, the README, and `DEMO.md` all lean on.

There is a real benefit being asked for here, and it is worth having: more models means more
comparisons, and comparison is what the cost meter exists to make vivid. The benefit comes from
_well-chosen breadth_, not from exhaustiveness.

### The spike

Time-boxed. Produces findings and a recommendation; **changes no application code** beyond whatever
throwaway probing is needed.

**Method, per candidate model:**

1. Probe with `cf ai run <model> --body @file.json` using a deliberately invalid body to elicit the
   validator's own field list, then a minimal valid body to capture the real response envelope. Use
   `--body @file` rather than an inline argument — inline arguments have been truncated by the shell
   before now, producing `{}` results that look like model failures and are not. This is a lesson
   already paid for in phase 17.
2. Record: input shape, output envelope, whether it streams, whether it emits reasoning content,
   pricing unit, and any control parameters with their real ranges.
3. Classify into one of four buckets.

**Classification buckets:**

- **Include as-is** — fits an existing panel's contract with no code change. Cheap, pure win.
- **Include with work** — fits the panel conceptually but needs a parser, control mapping, or UI
  change. Record the specific work and its size so it can be approved or declined individually.
- **Exclude, structural** — no panel fits (Dumb Pipe, inpainting). Record the reason.
- **Exclude, editorial** — technically fits but harms the demo (LoRA adapters, near-duplicate
  variants that teach nothing new). Record the reason.

**Deliverables:**

- A per-task-type table of every candidate with its bucket and one-line justification.
- A concrete recommendation for how many and which models each panel should offer, with the
  comparison each selection is meant to enable — fast versus quality, cheap versus capable,
  different embedding dimensions, and so on.
- A written proposal for reasoning-model output: suppress, disclose, or exclude. This is the one
  item that must be settled before any Text Generation model is added.
- An estimate for the resulting implementation phase.

**Explicit non-goals for the spike:** no descriptors added, no `models.ts` edits, no UI changes.

### Guidance for whatever implementation follows

- **Target well-chosen breadth, not exhaustiveness.** Likely two to five models per panel, each
  earning its place by enabling a comparison the others do not.
- **Record exclusions in the repository, not only in the spike.** A model deliberately left out
  should be findable with its reason, the same way `AI-GATEWAY-EXCEPTIONS.md` makes the one gateway
  exception visible. "Nobody considered it" and "considered and declined" must stay distinguishable.
- **If the decision ends up being genuinely all hosted models**, that is legitimate, but the
  "reviewed model" language across `models.ts`, the README, `DEMO.md`, and the architecture tests
  must be revisited in the same phase. The claim has to match what the code does.
- Keep the per-task summary the original item asks for; it is a good reporting format and should
  survive into the spike's output.
