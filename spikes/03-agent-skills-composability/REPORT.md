# Spike D Report

Run 2026-08-03 against the real Cloudflare account (`spike-03-agent-skills-composability`
deployed to `https://spike-03-agent-skills-composability.adrian-hall-internal-demo.workers.dev`,
fronted by a bypass-all Access application, backed by a real `spike-03-agent-skills` R2 bucket).
All findings below are either **live-observed** (an actual request/response over the deployed
Worker) or **source-verified** (read directly from the installed `agents`/`workers-ai-provider`
package's shipped `dist/*.d.ts`/`dist/*.js`). Each finding says which.

## 1. Exact package versions used

| Package | Version | Notes |
| --- | --- | --- |
| `agents` | `0.20.1` | same as Spike A; `agents/skills` ships in this version |
| `@cloudflare/ai-chat` | `0.10.1` | same as Spike A |
| `ai` | `7.0.48` | same as Spike A |
| `workers-ai-provider` | `4.0.0` | same as Spike A |
| `@cloudflare/codemode` | `0.5.1` | required only because `agents/skills` imports it unconditionally — see §2 |
| `just-bash` | `3.2.0` | required for the same reason — see §2 |
| `wrangler` | `4.115.0` | pinned, matches every other spike/demo in this repo |
| `typescript` | `^7.0.2` | matches Spike A/C |

## 2. The decision: adopt the released mechanism, not the hand-rolled fallback

**`agents/skills` is composable with `AIChatAgent` directly — it is not `Think`-only.** This
corrects `docs/06-AGENTIC-CHAT.md`'s framing of the released Agent Skills feature as living inside
`@cloudflare/think`'s `agents:skills` import. Source-verified: the mechanism actually lives in the
`agents` package's own `agents/skills` subpath export (`SkillRegistry`, `r2()`,
`fromManifest()`, `runner()`, `parseSkillMarkdown()`), which `@cloudflare/think` merely *also*
imports internally — it has no dependency on `Think`, no dependency on `@cloudflare/think` at all,
and no import of React or any chat-UI concern. `agents:skills` (the string in
`docs/06-AGENTIC-CHAT.md`'s Alternatives-table row) is a **separate, unrelated thing**: a
build-time-only virtual module the Agents *Vite plugin* resolves for a *bundled* skill directory
(`agents/skills-module.d.ts`'s own doc comment: "`import skills from \"agents:skills\"`... is
resolved at build time by the `agents()` Vite plugin"). This spike does not use it — bundled,
build-time skills are a different source (`fromManifest()`-shaped) from the R2-backed, runtime-
discovered skills the demo's US-10 (personal/enterprise skills users add themselves, without a
redeploy) actually needs.

`SkillRegistry.tools()` returns a plain `ai`-SDK `ToolSet` (built with the exact same `tool()`
helper a hand-rolled tool would use), and `SkillRegistry.systemPrompt()` returns a plain string —
both slot directly into `streamText()`'s `tools`/`system` arguments with **zero adapter code**,
confirmed live (§6). **Decision: `docs/06-AGENTIC-CHAT.md`'s Alternatives table is updated
(below) to prefer the released `SkillRegistry`/`r2()` mechanism over the hand-rolled catalog+R2
design it previously specified as the fallback** — the fallback design existed only for the case
where the released feature turned out not to be composable, and it is.

**Real cost: `agents/skills` unconditionally imports `@cloudflare/codemode` and `just-bash` at
module top level, even when only `activate_skill`/`read_skill_resource` are used.**
Source-verified: `agents/dist/skills/index.js`'s own top-of-file imports include
`import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode"` and
`import { Bash, defineCommand } from "just-bash"` — both used only by the `runner()` function
(the `worker_loaders`-backed `run_skill_script` executor this spike never calls), but imported
unconditionally, so both packages must be installed as real dependencies (they are marked
`optional: true` in `peerDependenciesMeta`, but `optional` peer-dependency metadata does not
exempt an unconditionally-imported module from needing the package physically present for
bundling) and both ship in the deployed Worker's bundle regardless of whether a demo ever uses
skill scripts. Live-measured bundle-size cost of this, isolated by diffing this spike's dry-run
build against an otherwise-identical build with `agents/skills` removed:

| Build | Raw | Gzip |
| --- | --- | --- |
| Spike A shape (no `agents/skills`) | 2840.87 KiB | 533.70 KiB |
| This spike (`agents/skills` imported, `runner()` never called) | 4479.79 KiB | 912.45 KiB |
| **Delta** | **+1638.92 KiB (+58%)** | **+378.75 KiB (+71%)** |

Both totals stay well under either Workers plan's compressed-size ceiling, so this is not a
deployability blocker, but it is a real, avoidable-if-the-package-tree-shook-better cost worth
calling out in `EXPLAIN-DEMO.md` for Phase 11 — `just-bash` alone unpacks to ~24 MB in
`node_modules` (mostly `quickjs-emscripten`/`sql.js`, used only by `run_skill_script`'s Python/Bash
runtimes). If Phase 11 never needs `run_skill_script`, this cost buys nothing; if it does, the
cost is unavoidable with the released package as shipped today.

## 3. `wrangler.jsonc` shape (live-verified)

```jsonc
{
  "name": "spike-03-agent-skills-composability",
  "main": "./src/index.ts",
  "compatibility_date": "2026-07-29",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "CHAT_AGENT", "class_name": "ChatAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatAgent"] }],
  "ai": { "binding": "AI", "remote": true },
  "r2_buckets": [{ "binding": "SKILLS", "bucket_name": "spike-03-agent-skills" }]
}
```

Adds only an `r2_buckets` binding to Spike A's shape. **No `worker_loaders` binding is needed** —
`activate_skill`/`read_skill_resource` need no Dynamic Worker at all; only `run_skill_script`
(never exercised here) needs the `runner()` factory's `WorkerLoader`.

## 4. `r2()`'s skill-directory convention (source-verified + live-verified)

`agents/skills`'s `r2(bucket, { prefix })` source discovers a skill by scanning for
`{prefix}{directory}/SKILL.md` objects — one skill per top-level directory under `prefix`, each a
YAML-frontmatter Markdown file (`name`/`description`/optional `compatibility`/`license`/
`allowed-tools`/`metadata`) plus any sibling files as on-demand resources, classified by path
prefix (`references/*` → `reference`, `scripts/*` → `script`, `assets/*` → `asset`, anything else
→ `file`). This spike's fixture (`fixtures/skills/cloudflare-spike-fact/`) uploaded to
`skills/cloudflare-spike-fact/SKILL.md` and
`skills/cloudflare-spike-fact/references/passphrase.md` via `wrangler r2 object put --remote`,
read back correctly by `r2(env.SKILLS, { prefix: "skills/" })` with zero custom parsing code.
`r2()`'s own listing is cached in memory for `refreshIntervalMs` (default 60 s) — a personal/
enterprise skill a user just uploaded is visible to the *next* chat turn within that window, not
necessarily the very next request; Phase 11 should decide whether that lag is acceptable or
whether to call `refresh()` explicitly after an upload.

## 5. `SkillRegistry.tools()`'s exact tool set (source-verified)

With one skill registered, `.tools()` returns exactly two tools (`run_skill_script` is added only
when a `scriptRunner` is passed to `SkillRegistry`'s constructor, which this spike never does):

- **`activate_skill`** — `inputSchema: z.object({ name: z.enum([...skill names]) })`. Returns the
  skill's full Markdown body wrapped in a `<skill_content>` tag, plus a rendered list of its
  bundled resources — exactly the "catalog in the prompt, content on demand" shape
  `docs/06-AGENTIC-CHAT.md`'s hand-rolled fallback design described, already built.
- **`read_skill_resource`** — `inputSchema: z.object({ name: z.enum([...]).optional(), path:
  z.string().min(1) })`. Returns one bundled resource's content wrapped in a `<skill_resource>`
  tag, base64-encoded for binary files (per extension) or plain text otherwise.

`.systemPrompt()` returns `null` when no skills are registered (so an empty catalog costs nothing
in the system prompt — confirmed by reading `snapshot()`'s `catalog.length ? [...] : null`), or a
short, fixed-shape catalog block otherwise:

```
Available skills. When a task matches a skill, use activate_skill with its name before proceeding.

- cloudflare-spike-fact: Use whenever the user asks for "the spike passphrase" or "today's spike fact". Provides a piece of information that is not otherwise available to the assistant.
```

Only the skill's `name`/`description` land in every turn's prompt (never its full body), matching
US-10's "must not bloat every prompt" acceptance criterion structurally, independent of how many
skills exist or how long their content is.

## 6. Live end-to-end proof, and a real bug this spike hit and fixed

**First attempt failed: a skill-matching question produced narrated text
(`"activate_skill cloudflare-spike-fact"`) instead of a real tool call, consistently, across
every model tried (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, then
`@hf/nousresearch/hermes-2-pro-mistral-7b` — discovered deprecated 2026-05-30 mid-spike, then
`@cf/zai-org/glm-4.7-flash`).** This looked at first like a model or `workers-ai-provider`
streaming-reliability problem (`workers-ai-provider`'s own source has a real, separate "salvage"
mechanism for a documented "gpt-oss harmony quirk" where a *forced* tool call streams as text —
see `src/utils.ts`'s `salvageToolCallsFromText`/`isForcedToolChoice`), and this spike spent real
effort chasing that theory (a two-`streamText()`-call workaround, confirmed to "fix" the symptom
under a *forced* `toolChoice`) before finding the actual cause below. That theory is **not** what
was actually wrong here, but it is a real, independently-confirmed provider behavior worth keeping
in mind for anything that forces `toolChoice` on a Workers AI model in the future — see §8's "false
leads ruled out" for the live evidence.

**The actual bug: calling `registry.tools()` concurrently with `registry.systemPrompt()` (for
example via `Promise.all([registry.systemPrompt(), registry.tools()])`) silently returns an empty
tool set.** `SkillRegistry.tools()` reads its already-loaded descriptor map **synchronously** — it
neither calls nor awaits `.load()` itself (source-verified, `dist/skills/index.js`'s `tools()`
method body). `.systemPrompt()` (via `.snapshot()`) is what triggers `.load()`, which does a real,
awaited R2 `list()`/`get()` round trip. `Promise.all([a, b])` evaluates `a` and `b` **synchronously
at call time** before awaiting either, so `registry.tools()` always ran before `.load()`'s first
`await` had a chance to populate anything — deterministically, not flakily, every single time this
spike called it that way. The result: `modelSkillNames.length === 0` inside `.tools()`, so neither
`activate_skill` nor `read_skill_resource` is ever added to the returned object — no error, no
warning, just `{}`. Meanwhile `registry.systemPrompt()` (correctly awaited on its own) still
described the skill and instructed the model to "use activate_skill" — so the model narrated
exactly that instruction as plain text, because no such tool actually existed for it to call. This
reproduced identically across the earlier "streaming" and "non-streaming" test paths alike, since
both used the same broken `Promise.all` construction — which is exactly why switching models,
switching streaming for non-streaming, and switching `toolChoice` all appeared to matter or not
matter somewhat randomly: none of it was the actual variable.

**Fix: await `registry.systemPrompt()` to completion, then call `registry.tools()` afterward, not
concurrently.**

```ts
// Wrong — registry.tools() runs before registry.systemPrompt()'s internal .load() completes.
const [catalogPrompt, skillTools] = await Promise.all([
  registry.systemPrompt(),
  registry.tools(),
]);

// Right — sequential, so .tools() sees the populated descriptor map.
const catalogPrompt = await registry.systemPrompt();
const skillTools = registry.tools();
```

With that fix, the plain, single-`streamText()`-call design (identical in shape to Spike A's own
`onChatMessage` — see `src/index.ts`) worked correctly, live, on the first try:

- **Skill-matching prompt** (`"What is the spike passphrase?"`): the model correctly chained
  `activate_skill({ name: "cloudflare-spike-fact" })` → (reads the skill body's own instruction to
  fetch the passphrase) → `read_skill_resource({ name: "cloudflare-spike-fact", path:
  "references/passphrase.md" })` → a final answer containing the exact fixture passphrase,
  `TURQUOISE-NARWHAL-77`, verbatim — a value the model has no way to know except by actually
  reading the R2 object through the tool chain. Observed UI-message-stream part types:
  `tool-input-start`, `tool-input-delta`, `tool-input-available`, `tool-output-available` appeared
  correctly for both tool calls, streamed to the client exactly like Spike A's plain-text parts.
- **Non-matching prompt** (`"What is 12 times 7?"`): the model's own streamed reasoning explicitly
  noted "This is not related to the available skills," called no tool at all, and answered
  directly (`"12 × 7 = 84"`) — confirming US-10's "activates only when the task matches" behavior
  end to end, not merely a schema-shape claim.

## 7. `SkillRegistry`'s catalog instruction must not be repeated to a tool-less call

A secondary bug this spike hit while exploring the (ultimately unnecessary) two-phase workaround:
reusing the *same* system prompt — including `systemPrompt()`'s "use activate_skill with its name
before proceeding" instruction — for a second model call that has no `tools` attached at all
causes the model to narrate the tool-call instruction as text again, because it is still being
told to use a tool that, for that specific call, does not exist. This is not a `SkillRegistry` bug
— it is a direct consequence of including the skill catalog in the system prompt for any call that
does not also carry `SkillRegistry.tools()` in `tools`. Not relevant to the final single-call
design (§6), but worth documenting for Phase 11 if a future design ever splits skill resolution
across multiple model calls for a different reason (cost, latency, or a provider-specific
constraint another model surfaces): the catalog instruction belongs only in a system prompt paired
with the matching tool set, never carried into a call that omits it.

## 8. False leads ruled out (kept for anyone hitting the same symptom)

- **Not a streaming-vs-non-streaming issue.** A raw, non-streaming `env.AI.run()` binding call
  with a hand-built `tools` array (bypassing `workers-ai-provider`/`SkillRegistry` entirely)
  correctly returned a structured `tool_calls` array under the SDK's default (unforced) tool
  choice — as did a hand-rolled `generateText()` call using `tool()`-defined tools with no
  `SkillRegistry` involved, and a hand-rolled `streamText()` call with two tools mirroring
  `SkillRegistry.tools()`'s exact schema/description shape. All three succeeded; only the actual
  `SkillRegistry.tools()` call (via the `Promise.all` race in §6) failed. Streaming was never the
  variable.
- **Not the model.** `llama-3.3-70b-instruct-fp8-fast`, `glm-4.7-flash`, and (via direct REST,
  before its deprecation was discovered) `hermes-2-pro-mistral-7b` all correctly returned
  structured tool calls once the `Promise.all` race was fixed or bypassed.
- **A real, separate, confirmed `workers-ai-provider` behavior — just not this bug's cause.**
  Forcing `toolChoice: { type: "tool", toolName: "activate_skill" }` on a hand-rolled `streamText()`
  call (still not going through `SkillRegistry`) reliably produced correct streamed
  `tool-input-start`/`tool-input-delta`/`tool-input-available` parts across three consecutive
  forced steps — confirming `workers-ai-provider`'s documented forced-tool-choice salvage path
  (`isForcedToolChoice`) works as designed. This remains true and useful to know (any future
  design that must force a tool choice for a different reason can rely on it), but it is
  independent of, and was not the fix for, this spike's actual bug.
- **Not AI Gateway.** A raw REST call to the OpenAI-compatible endpoint with an explicit
  `cf-aig-gateway: default` header, and a raw `env.AI.run()` binding call through
  `workers-ai-provider`'s `gateway: { id: "default" }` option, both returned structured tool calls
  correctly once outside the `Promise.all` race — the AI Gateway hop itself is not implicated.
- **One unreproduced transient error, noted for completeness, not investigated further:** a single
  request to `glm-4.7-flash` immediately after switching this spike's model constant returned `AI
  error 5028: This model was deprecated on 2026-05-30. Please use an alternative model.` — a
  message otherwise only ever seen for the genuinely-deprecated `hermes-2-pro-mistral-7b`. Every
  other request to `glm-4.7-flash`, immediately before and after, succeeded normally; this did not
  recur across roughly a dozen subsequent calls. Recorded here per Section 8's "corrections... are
  exactly as valuable a finding as a confirmation" — but with only one occurrence, it reads as an
  unrelated, transient platform hiccup rather than a `glm-4.7-flash`-specific finding.

## Updated `docs/06-AGENTIC-CHAT.md` Alternatives-Table Row

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Skills mechanism | The released Agents SDK mechanism (`agents/skills`'s `SkillRegistry` + `r2()` source, confirmed composable with `AIChatAgent` by Spike D) | A hand-rolled skill catalog + R2 storage | Spike D confirmed the released mechanism is `AIChatAgent`-agnostic (not `Think`-only, and not the same thing as the Vite-plugin-only `agents:skills` virtual module docs/06-AGENTIC-CHAT.md originally named) — it is a plain `ai`-SDK `ToolSet` plus a plain system-prompt string, needing zero adapter code once `SkillRegistry.tools()` is called *after* awaiting `.systemPrompt()`, not concurrently with it (a real bug this spike hit — see `spikes/03-agent-skills-composability/REPORT.md` §6). Building the hand-rolled equivalent this row previously specified would duplicate a feature that already exists and already matches the exact "catalog in prompt, content on demand" shape the fallback was designed to approximate. |

## Follow-ups not covered by this spike

- **`run_skill_script`** (Python/Bash/JS script resources via a `worker_loaders`-backed
  `SkillScriptRunner`) — not exercised. Phase 11 should decide whether any of this demo's
  personal/enterprise skills need executable scripts at all before paying `agents/skills`'
  already-unconditional `just-bash`/`@cloudflare/codemode` bundle cost (§2) a second time by also
  wiring a `runner()` (which needs Spike C's `worker_loaders`/`ctx.exports` pattern).
- **Personal vs. enterprise skill scoping** (US-10: a personal skill invisible to other users, an
  enterprise skill visible to everyone) — this spike used one flat `r2()` source with no
  owner-scoping. Phase 11 will likely need two `SkillSource`s in the same `SkillRegistry` (a
  per-user-prefixed personal source and a shared enterprise source), or a single source with an
  `options.skills` allow-list computed per request from D1 — `r2()`'s `options.skills` parameter
  (source-verified in §5's type signature) exists for exactly this kind of filtering but was not
  exercised live here.
- **Removing a skill's effect "on the next turn"** (US-10's acceptance criterion) — not measured
  precisely. `r2()`'s default 60-second `refreshIntervalMs` (§4) means a deletion's effect has the
  same up-to-60-second lag as an addition's; Phase 11 should decide whether that is acceptable or
  whether every skill-catalog mutation should call `registry.refresh()` (or reconstruct the
  registry) explicitly.
- **Cost/latency of the catalog+tool round trip itself** — not measured against a no-skills
  baseline. Every turn now pays for `r2()`'s listing (cached after the first, per §4) plus, when a
  skill matches, at least one extra model step per tool call. Not a correctness concern, but worth
  a real latency measurement in Phase 11 alongside Spike F's cost-ledger work.
