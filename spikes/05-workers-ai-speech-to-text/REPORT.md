# Spike E Report

Run 2026-08-03 against the real Cloudflare account (`spike-05-workers-ai-speech-to-text` deployed
to `https://spike-05-workers-ai-speech-to-text.adrian-hall-internal-demo.workers.dev`, fronted by
a bypass-all Access application). All findings below are **live-verified** (an actual
request/response over the deployed Worker, or a direct REST call against the same account) or
**source-verified** (read directly from the installed package's shipped `dist/*.d.ts`/`dist/*.js`
— a real, current primary source). Each finding says which. Raw per-request JSON is in
`fixtures/` alongside the code that produced it; the numbers quoted below are drawn from two
full, repeated runs of the matrix (`scripts/probe.mjs` with no filters).

## 1. Exact package versions used

| Package | Version | Notes |
| --- | --- | --- |
| `ai` | `7.0.48` | matches Spike A's pin |
| `workers-ai-provider` | `4.0.0` | matches Spike A's pin; latest on npm at spike time |
| `wrangler` | `4.115.0` | pinned, matches every other demo/spike in this repo |
| `typescript` | `^7.0.2` | matches every other demo/spike in this repo |

## 2. `@cf/openai/whisper-large-v3-turbo`'s input contract (live-verified, both call paths)

The model's raw JSON Schema (`developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/schema-input.json`)
declares `audio` as `anyOf` a **base64-encoded string** or an (undocumented-by-example)
`{ body, contentType }` object. Both this spike's own direct `env.AI.run()` call
(`binding-base64` mode) and `workers-ai-provider`'s shipped `runWhisper()` (confirmed by reading
`node_modules/workers-ai-provider/dist/index.mjs`) use only the **base64-string** form —
`{ audio: uint8ArrayToBase64(bytes) }` — never the object form. This spike never exercised the
object form for this model; `binding-base64` and `experimental-transcribe` are both,
mechanically, the same base64-string call underneath.

**No client-side audio conversion is required.** The same ~12-second synthesized utterance
(`fixtures/utterance.webm`, `audio/webm;codecs=opus` — the same container/codec pair a browser's
`MediaRecorder` produces by default, generated here with `ffmpeg`'s real `libopus`/`webm` muxer,
not approximated) and `fixtures/utterance.wav` (16-bit PCM, client-side-converted) were both
base64-encoded and posted through the identical code path, with **no format-specific branching**.
Both returned a full, accurate transcription, and — the clean cross-check — both reported the
**identical** `transcription_info.duration`/`duration_after_vad` (`11.9684375` seconds, matching
the source utterance's actual length), proving the model decoded the Opus-in-WebM container
correctly rather than truncating or misreading it:

```json
// fixtures/utterance.webm, mode=binding-base64
{ "language": "en", "language_probability": 1, "duration": 11.9684375, "duration_after_vad": 11.9684375 }
// fixtures/utterance.wav, mode=binding-base64 — identical
{ "language": "en", "language_probability": 1, "duration": 11.9684375, "duration_after_vad": 11.9684375 }
```

**Recommendation for Phase 5 (US-4)**: post the browser's raw `MediaRecorder` Blob
(`audio/webm;codecs=opus`) directly to `POST /api/transcribe`; base64-encode it server-side; call
`env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: base64 })`. No client-side re-encoding
step, no extra dependency, no `ffmpeg`/WASM transcoder in the browser bundle.

**Correction — `ai@7.0.48`'s `experimental_transcribe()`/`transcribe()` has no `mediaType`
parameter at all**, contradicting Cloudflare's own `workers-ai-provider` changelog example
(`developers.cloudflare.com/changelog/post/2026-02-13-glm-4.7-flash-workers-ai/`), which shows
`experimental_transcribe({ model, audio: audioData, mediaType: "audio/wav" })`. This spike's own
first draft passed `mediaType` and got a clean `tsc` type error (`Object literal may only specify
known properties, and 'mediaType' does not exist in type '{ model: TranscriptionModel; audio: URL
| DataContent; ... }'`) rather than a silently-ignored option — confirmed by reading
`node_modules/ai/dist/index.js`'s `transcribe()` body directly:

```js
mediaType: detectMediaType5({ data: audioData, topLevelType: "audio" }) ?? "audio/wav"
```

The SDK now derives the media type itself via **magic-byte sniffing** over the raw audio bytes
(`node_modules/@ai-sdk/provider-utils/dist/index.js`'s `audioMediaTypeSignatures`, which includes
`audio/webm` keyed on the EBML signature `[0x1A, 0x45, 0xDF, 0xA3]` — confirmed this spike's own
`fixtures/utterance.webm` starts with exactly those four bytes), never from the caller's HTTP
`Content-Type` header at all. Any demo code following that changelog example verbatim against the
currently-pinned `ai@7.0.48` will fail `tsc --noEmit` immediately, not silently misbehave — a
low-severity but real doc/SDK-version drift worth flagging.

**Correction — `experimental_transcribe()`'s normalized output drops Whisper's per-word
timestamps.** The raw binding response's `segments[].words[]` array (individual word start/end
times, used for a "highlight the word being read" UI) is present in `binding-base64`'s raw
response but **absent** from `experimental-transcribe`'s normalized `TranscriptionResult` —
confirmed by reading `workers-ai-provider`'s `normalizeWhisperResponse()`, which maps only
`{ text, startSecond, endSecond }` per segment and only falls back to word-level entries for
models (like classic `@cf/openai/whisper`) that return `words` at the top level rather than
nested per-segment. If a later phase wants word-level highlighting, it must call `env.AI.run()`
directly (`binding-base64`'s shape) rather than going through `experimental_transcribe()`.

## 3. `@cf/deepgram/nova-3`: `workers-ai-provider`'s own documented binding shape is live-rejected
   by the platform (live-verified, three independent call paths, plus a direct REST comparison)

Nova-3's generated Wrangler type (`Ai_Cf_Deepgram_Nova_3_Input`) declares `audio: { body: object,
contentType: string }`, both required — but `workers-ai-provider`'s shipped `runNova3()`
(`dist/index.mjs`) actually sends `{ audio: { body: uint8ArrayToBase64(audioBytes), contentType }
}` for the `env.AI` binding path, i.e. `body` is a **base64 string** at runtime despite the
generated type saying `object`.

**This exact shape — copied verbatim from the provider's own source — is live-rejected by the
platform**, every time, for both audio fixtures, via three independent call paths this spike
tried:

1. This spike's own direct `env.AI.run("@cf/deepgram/nova-3", { audio: { body: <base64>,
   contentType } })` (`nova3` mode).
2. The exact same call with `body` as a **raw, non-base64-encoded `Uint8Array`** instead
   (`nova3-raw-bytes` mode) — ruling out "the platform wants raw bytes, not base64" as the fix.
3. `workers-ai-provider`'s own `experimental_transcribe()` with
   `workersai.transcription("@cf/deepgram/nova-3")` (`nova3-experimental-transcribe` mode) — the
   exact code path a real demo would call, ruling out "this spike's hand-rolled call is
   malformed."

All three fail identically:

```json
{ "error": "5006: Error: required properties at '/audio' are 'body,contentType'" }
```

**A direct REST API call (bypassing the Workers binding, `workers-ai-provider`, and this spike's
Worker entirely) confirms this is a genuine platform-side schema-validation quirk, not this
spike's bug**: the same JSON body (`{"audio":{"body":"<base64>","contentType":"audio/wav"}}`)
posted to `POST /accounts/{account}/ai/run/@cf/deepgram/nova-3` returns the identical `5006`
error. **The only shape that actually works for nova-3, live-verified, is the REST endpoint's raw
binary body upload** — no JSON wrapper at all, the audio's real bytes as the HTTP body with
`Content-Type: audio/wav` set directly:

```bash
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/ai/run/@cf/deepgram/nova-3 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: audio/wav" --data-binary @utterance.wav
# → 200, full Deepgram-shaped transcript
```

This matches `workers-ai-provider`'s own `!isBinding` (REST, non-binding) code path
(`createRunBinary()`, a genuinely different upload mechanism than the JSON-bodied binding call) —
but **the Workers `env.AI` binding itself only ever accepts a JSON-serializable inputs object**,
so this raw-binary-body shape is not reachable from inside a Worker via the binding at all.

**Conclusion: `@cf/deepgram/nova-3` is not currently usable for transcription via the `env.AI`
Workers binding on this account**, regardless of which of the three documented/plausible input
shapes is tried — only its REST endpoint's binary-body upload works, which a Worker cannot use
through the binding. This is a second, independent, and now empirically stronger reason (beyond
Section 6's "nova-3 is a real-time-streaming-first design, a worse fit than Whisper for a
one-shot record-then-transcribe flow") to standardize this demo on
`@cf/openai/whisper-large-v3-turbo` for Phase 5 — worth reporting upstream to
`workers-ai-provider`/Cloudflare, since its own shipped code demonstrably does not work against
its own platform's current schema validation for this one model.

## 4. `@cf/openai/whisper` (classic, non-turbo): also accepts both formats, but slower and
   lower-quality than turbo (live-verified)

`{ audio: Array.from(bytes) }` (Cloudflare's own documented shape for this model — the
`transform-videos/bindings` doc's own example uses the identical `[...new
Uint8Array(...)]`) worked for both `utterance.webm` and `utterance.wav` with no decoding errors —
this model **also** tolerates a WebM/Opus container fed as a raw byte array, not only genuinely
"raw" PCM/WAV/FLAC as its docs might imply. However, its output is measurably lower quality
(capitalizes the brand name as "CloudFlare", not "Cloudflare"; drops the possessive apostrophe
"workers'" → "workers"; renders "speech to text" without turbo's hyphenation) and measurably
slower — see the latency table below. This is a second confirmation the turbo model, not the
classic one, is the correct choice for Phase 5.

## 5. Output shape (live-verified, matches the documented raw JSON Schema exactly)

`binding-base64`'s raw response for `@cf/openai/whisper-large-v3-turbo` exactly matches
`developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/schema-output.json`:

```json
{
  "transcription_info": { "language": "en", "language_probability": 1, "duration": 11.9684375, "duration_after_vad": 11.9684375 },
  "text": "The quick brown fox jumps over the lazy dog, while Cloudflare workers' AI transcribes this roughly 10-second test utterance for the speech-to-text spike, confirming both the input contract and the realistic end-to-end latency.",
  "word_count": 33,
  "segments": [ { "start": 0, "end": 11.7, "text": " ...", "temperature": 0, "avg_logprob": -0.0996, "compression_ratio": 1.32, "no_speech_prob": 0, "words": [ { "word": " The", "start": 0, "end": 0.14 }, "... one entry per word ..." ] } ],
  "vtt": "WEBVTT\n\n00:00.000 --> 00:00.140\n The\n\n..."
}
```

`experimental-transcribe`'s normalized `TranscriptionResult` (the `ai` SDK's own shape, not
Workers AI's) is simpler and, as Section 2 notes, drops the per-word `words[]` array:

```json
{
  "text": "...",
  "segments": [ { "text": " ...", "startSecond": 0, "endSecond": 11.7 } ],
  "language": "en",
  "durationInSeconds": 11.9684375,
  "warnings": [],
  "responses": [ { "timestamp": "2026-08-03T09:26:08.484Z", "modelId": "@cf/openai/whisper-large-v3-turbo", "headers": {} } ],
  "providerMetadata": {}
}
```

## 6. Latency for a ~12-second utterance (live-verified, two full repeated runs)

`elapsedMs` times only the model call itself (`env.AI.run()`/`experimental_transcribe()`'s own
`await`), excluding this spike's own request-body parsing; `wallMs` is the full round trip
measured by `scripts/probe.mjs` running as a plain Node script outside Cloudflare's network
(so it also includes that script's own regional network latency to the Worker, not just the
Worker-to-Workers-AI hop a browser-facing demo would actually pay).

| Mode | Fixture | `elapsedMs` (2 runs) | `wallMs` (2 runs) |
| --- | --- | --- | --- |
| `binding-base64` (turbo) | webm-opus | 859, 2296 | 1095, 2506 |
| `binding-base64` (turbo) | wav | 822, 1495 | 953, 1608 |
| `experimental-transcribe` (turbo) | webm-opus | 885, 1852 | 968, 1932 |
| `experimental-transcribe` (turbo) | wav | 2587, 2624 | 2780, 2722 |
| `binding-array` (classic) | webm-opus | 3440, 1129 | 3502, 1198 |
| `binding-array` (classic) | wav | 1213, 913 | 1316, 1038 |

Model-call latency for the turbo model, the one this demo should use, landed **roughly
800ms–2.6s** for a ~12-second utterance across repeated live calls — well inside an interactive
"record → transcribe → edit → submit" UX (US-4's acceptance criterion), and in the same rough
window as demo 5's non-reasoning first-token latency this demo's own Section 4 asks Phase 2 to
match. The spread run-to-run (both formats, both call paths) looks like ordinary shared-inference
capacity variance rather than anything tied to audio format or call shape specifically — no
format/mode combination was consistently and only ever fast or only ever slow across both runs.

**Maximum duration is not documented by Cloudflare for this model** (`workers-ai/platform/limits/`
lists only a request-rate limit — 720 requests/minute for the "Automatic Speech Recognition" task
type — not a per-file duration or size ceiling). This spike's ~12-second test comfortably covers
any plausible per-turn dictation length for US-4's "record, then transcribe" flow, so pushing
toward an unknown ceiling was not a productive use of this spike's scope; record this as an open,
undocumented item rather than a false confirmed number, and revisit only if Phase 5 needs to
support materially longer recordings.

## Follow-ups not covered by this spike

- The maximum audio duration/file size `@cf/openai/whisper-large-v3-turbo` actually enforces
  (Section 6) — undocumented, not pushed to a real ceiling here.
- Whether nova-3's binding-path schema-validation failure (Section 3) is specific to this
  account/gateway configuration or a platform-wide current bug — worth a fresh check with a
  different `gateway.id` or a non-`default` AI Gateway (Spike B's scope) before concluding it is
  universal, though the direct REST-API reproduction (bypassing the binding, gateway, and this
  spike's Worker entirely) makes an account-specific cause unlikely.
- Whether `@cf/openai/whisper-large-v3-turbo`'s `vad_filter`/`initial_prompt`/other optional
  parameters change accuracy or latency meaningfully — out of this spike's scope (input
  format/latency only).
