/**
 * @file The Generate Music panel's wire contract. It sits in `src/shared/` beside the other panels'
 *   contracts because both tiers need it, and like them it carries no model descriptors — the
 *   browser learns which models exist and which controls each accepts from `/api/catalogue`. Three
 *   things make this contract different from every panel before it, and all three come from the
 *   reviewed model contracts rather than from a design preference. **The two models are billed in
 *   different units, and that is the panel's whole lesson.** ElevenLabs charges per second of
 *   output audio; MiniMax charges a flat price per track plus a separate charge for generating
 *   lyrics. Neither is a token. A cost meter that added a per-track charge to a per-token one and
 *   called the result "the total" would be arithmetically fine and conceptually wrong, so the unit
 *   travels with the estimate — see {@link MusicPricing} — and the UI names it wherever a figure
 *   appears. **The models disagree about whether a track even has a requested length.** ElevenLabs
 *   requires `music_length_ms` when no composition plan is given and accepts 3,000–600,000 ms.
 *   MiniMax has **no length field at all**: its schema sets `additionalProperties: false`, so
 *   sending `duration` is a rejected request rather than an ignored one. A length control therefore
 *   exists for one model and genuinely cannot exist for the other, which is also why the per-second
 *   estimate is possible for one and the per-track estimate is the honest answer for the other.
 *   **The result is a URL on the provider's own host, not bytes.** Both models answer with `{
 *   state: "Completed", result: { audio: "https://…" } }`. That URL is short-lived and belongs to
 *   someone else's CDN, so it is never given to the browser: the Worker fetches it once, from an
 *   allowlisted host, verifies the bytes by signature, and returns the audio in the response.
 *   Unlike Create Video nothing is stored — a track is a few megabytes, an `<audio>` element can
 *   seek freely within a payload the page already holds, and this demo makes no retention promise
 *   it would then have to keep. The provider-hosted original may expire at any time, and the panel
 *   says so rather than implying the link is durable.
 */

import {
  AUDIO_FILE_EXTENSIONS,
  isPlayableAudioMediaType,
  type AudioMediaType
} from './read-text.ts';
import type { RunReceipt } from './runs.ts';

/**
 * Longest style prompt the panel accepts, in characters.
 *
 * Set to the tightest of the reviewed models' documented limits rather than to each model's own, so
 * the editor's counter means the same thing whichever model is selected. MiniMax caps `prompt` at
 * 2,000 characters and ElevenLabs declares only `minLength: 1`; the lower bound governs. The server
 * still validates every request — a browser limit is a courtesy, never a control.
 */
export const MAX_MUSIC_PROMPT_CHARACTERS = 2_000;

/**
 * Longest set of caller-supplied lyrics the panel accepts, in characters.
 *
 * MiniMax's own `maxLength` for `lyrics`. It is the only reviewed model with a lyrics field at all,
 * so this is a transcribed provider limit rather than a demo-chosen one.
 */
export const MAX_MUSIC_LYRICS_CHARACTERS = 3_500;

/**
 * Longest track this panel will ask for, in seconds.
 *
 * **A demo-owned restriction, not a provider limit.** ElevenLabs accepts up to 600,000 ms — ten
 * minutes — and two things make that a poor fit here. The audio travels base64-encoded in the JSON
 * response rather than being stored, so a ten-minute WAV would be a payload this demo has no reason
 * to relay; and at $0.0025 per output second a ten-minute track is a dollar and a half for one
 * click. Two minutes is long enough to hear what a music model does and keeps the most expensive
 * possible run at thirty cents.
 *
 * The number is also where the panel's cost comparison becomes concrete: at sixty seconds the
 * per-second model costs exactly what the per-track model charges for a whole track, so a visitor
 * can watch which side of that line they are on.
 */
export const MAX_MUSIC_LENGTH_SECONDS = 120;

/**
 * Shortest track this panel will ask for, in seconds.
 *
 * ElevenLabs' own floor: `music_length_ms` has `minimum: 3000`.
 */
export const MIN_MUSIC_LENGTH_SECONDS = 3;

/**
 * Largest generated track this demo will relay, in bytes.
 *
 * A response bound rather than a storage bound, since the bytes travel base64-encoded in the JSON
 * body. Two minutes of 128 kbit/s MP3 is under two megabytes; the same length as uncompressed WAV —
 * which MiniMax will produce on request — is an order of magnitude larger, and sixteen megabytes
 * leaves room for that while still refusing a provider that answered with something far larger than
 * its own contract implies.
 */
export const MAX_MUSIC_BYTES = 16 * 1_024 * 1_024;

/**
 * Media type of a generated track, reusing the Read Text playback allowlist.
 *
 * Deliberately the same type as the speech panel's rather than a parallel copy, and the reason is
 * that it is the same constraint: both panels hand audio to an `<audio>` element from a `data:`
 * URI, and a `data:` URI's media type decides how the browser treats the payload. There is one
 * answer to "what will this demo play", so there is one definition of it.
 *
 * It is also why this panel offers only MP3 output formats for ElevenLabs. Its schema permits Opus
 * in an Ogg container, which is a perfectly good format and is not in this allowlist, so it is left
 * out of the reviewed format list rather than offered and then refused after it has been paid for.
 */
export type MusicMediaType = AudioMediaType;

/**
 * Reports whether a value is a media type this panel will play.
 *
 * @param value Candidate media type, sniffed from the bytes the provider actually returned.
 * @returns `true` when the type is in the shared playback allowlist.
 */
export function isPlayableMusicMediaType(value: string): value is MusicMediaType {
  return isPlayableAudioMediaType(value);
}

/**
 * File extension to offer when downloading each media type.
 *
 * Shared with Read Text for the same reason the type is: the extension has to agree with the
 * sniffed bytes, and two tables could disagree.
 */
export const MUSIC_FILE_EXTENSIONS: Readonly<Record<MusicMediaType, string>> =
  AUDIO_FILE_EXTENSIONS;

/**
 * Whether a model accepts caller-supplied lyrics.
 *
 * - `unsupported` — the model has no lyrics field. ElevenLabs is such a model: vocals are described
 *   in the prompt, and its schema sets `additionalProperties: false`, so a `lyrics` field would be
 *   a rejected request rather than an ignored one.
 * - `optional` — the model accepts lyrics, and may also be asked to write its own.
 */
export type MusicLyricsSupport = 'unsupported' | 'optional';

/**
 * Where the lyrics of a finished track came from.
 *
 * Three values rather than a boolean, because `model` is genuinely different from both others and
 * is the case a visitor most needs explained: MiniMax can write its own lyrics, charges separately
 * for doing so, and **does not return them**. The response carries an audio URL and nothing else,
 * so the panel states that the words exist only in the recording rather than leaving an empty
 * lyrics panel that looks like a rendering fault.
 *
 * - `caller` — the visitor supplied the lyrics, so the panel can display them.
 * - `model` — the model wrote them from the prompt and did not return the text.
 * - `none` — an instrumental track, so there are no lyrics at all.
 */
export type MusicLyricsSource = 'caller' | 'model' | 'none';

/**
 * How a music model bills, and what this demo can therefore estimate before the request.
 *
 * A discriminated union rather than one shape with optional fields, because the two reviewed models
 * do not merely differ in rate — they differ in **what the billable quantity is**. One multiplies a
 * price by a duration the caller chose; the other charges a fixed amount per track and adds a
 * second fixed amount when it has to write lyrics. Expressing that as a nullable "price per second"
 * would flatten the distinction this panel exists to show.
 *
 * The `unit` values match the `PricingUnit` labels the catalogue already publishes, so the figure
 * the panel quotes and the unit the model descriptor declares cannot disagree.
 */
export type MusicPricing =
  | {
      /**
       * Billed per second of generated audio.
       */
      unit: 'audio-second';
      /**
       * Price in US dollars for one second of output audio.
       */
      pricePerOutputSecondUsd: number;
    }
  | {
      /**
       * Billed per finished track, whatever its length.
       */
      unit: 'track';
      /**
       * Price in US dollars for one track.
       */
      pricePerTrackUsd: number;
      /**
       * Additional price in US dollars when the model is asked to write the lyrics itself.
       *
       * A separate charge rather than part of the track price, exactly as the catalogue publishes
       * it. It is the clearest evidence in the panel that "one request" and "one charge" are not
       * the same thing.
       */
      pricePerLyricsGenerationUsd?: number;
    };

/**
 * A numeric control a music model exposes, with the range the server will accept.
 *
 * Structurally similar to the other panels' range types and deliberately separate from them, for
 * the same reason: sharing one type would couple this panel's published contract to another's, so a
 * later change to a video control would silently alter what this panel advertises.
 */
export interface MusicNumericRange {
  /**
   * Lowest accepted value, inclusive.
   */
  min: number;
  /**
   * Highest accepted value, inclusive.
   */
  max: number;
  /**
   * Granularity for the UI control. Does not constrain validation.
   */
  step: number;
  /**
   * Value the server fills in when the control is omitted.
   */
  default: number;
}

/**
 * Which controls one music model supports, how it spells them, and what it charges.
 *
 * Every field is explicit rather than inferred, because the reviewed models disagree about all of
 * it: the instrumental flag has two different names, the output-format enums have no value in
 * common, a length control exists for one model and not the other, and the billing units themselves
 * differ. A field absent here is never forwarded — both schemas set `additionalProperties: false`,
 * which makes an undeclared field a request the provider is entitled to reject outright.
 */
export interface MusicControlSupport {
  /**
   * The wire name of the instrumental flag, which differs between reviewed models.
   *
   * ElevenLabs declares `force_instrumental`; MiniMax declares `is_instrumental`. The spelling is
   * pinned here rather than normalised in the request builder, because a provider validating its
   * own schema rejects the other name.
   */
  instrumentalParameterName: 'force_instrumental' | 'is_instrumental';
  /**
   * Whether the model's schema lists the instrumental flag as required.
   *
   * MiniMax requires `is_instrumental` even when it is `false`, so it is always sent for that
   * model. ElevenLabs treats `force_instrumental` as optional, so it is sent only when the caller
   * chose a value.
   */
  instrumentalParameterRequired: boolean;
  /**
   * Whether the model accepts caller-supplied lyrics; see {@link MusicLyricsSupport}.
   */
  lyrics: MusicLyricsSupport;
  /**
   * The wire name of the lyrics field. Absent for a model with no lyrics field at all.
   */
  lyricsParameterName?: 'lyrics';
  /**
   * The wire name of the flag asking the model to write its own lyrics.
   *
   * Absent for a model that cannot. Present for MiniMax, whose schema lists it as required and
   * whose catalogue page prices it as a separate charge.
   */
  lyricsOptimizerParameterName?: 'lyrics_optimizer';
  /**
   * Whether the model's schema lists the lyrics-writing flag as required.
   */
  lyricsOptimizerRequired?: boolean;
  /**
   * Whether the model refuses a vocal track with neither supplied nor generated lyrics.
   *
   * Declared because it is a documented provider refusal rather than a guess: MiniMax answers "When
   * 'is_instrumental' is false and 'lyrics_optimizer' is false, 'lyrics' must be provided".
   * Reimplementing the rule locally turns an opaque provider error into a message naming the three
   * ways out of it — and does so before the request is paid for.
   */
  requiresLyricsForVocals?: boolean;
  /**
   * The wire name of the track-length control. Absent for a model with no length field.
   */
  lengthParameterName?: 'music_length_ms';
  /**
   * The unit the length control is expressed in on the wire.
   *
   * Declared because it is not the unit the visitor chooses. The panel works in whole seconds,
   * which is what a person thinks in; ElevenLabs takes milliseconds. Recording the wire unit beside
   * the wire name keeps the conversion in one reviewed place.
   */
  lengthUnit?: 'milliseconds';
  /**
   * Accepted track length in seconds, as this panel exposes it.
   *
   * Absent for a model with no length control, which is a genuine capability difference rather than
   * an omission: MiniMax decides the length itself and rejects any field that tries to set it.
   */
  lengthSeconds?: MusicNumericRange;
  /**
   * The wire name of the output-format control, which differs between reviewed models.
   */
  formatParameterName: 'output_format' | 'format';
  /**
   * Accepted output-format values, exactly as the model's own schema enumerates them.
   *
   * Spelling matters: these are validated against an enum, and the two reviewed models share no
   * value at all — `mp3_44100_128` against `mp3`. That is why the list is per model rather than one
   * set of names for the panel.
   */
  formats: readonly string[];
  /**
   * Format used when the caller does not choose one.
   */
  defaultFormat: string;
  /**
   * Whether the model accepts a seed for reproducible output.
   */
  seed: boolean;
  /**
   * How the model bills, and what can be estimated before the request; see {@link MusicPricing}.
   */
  pricing: MusicPricing;
  /**
   * Exact HTTPS hosts the model's audio URL may come from.
   *
   * An allowlist, because the returned URL is fetched server-side and a model that could name any
   * host would make this Worker a general-purpose fetcher. The hosts are taken from each model's
   * published examples; a provider that starts serving from a new CDN host is refused with a `502`,
   * and the rejected host is logged so the list can be corrected from the log rather than by
   * guesswork.
   */
  outputHosts: readonly string[];
}

/**
 * Every control name a Generate Music request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const MUSIC_CONTROL_NAMES = [
  'instrumental',
  'lyrics',
  'generateLyrics',
  'lengthSeconds',
  'format',
  'seed'
] as const;

/**
 * One optional Generate Music control; see {@link MUSIC_CONTROL_NAMES}.
 */
export type MusicControlName = (typeof MUSIC_CONTROL_NAMES)[number];

/**
 * Why a run failed, in terms a visitor can act on.
 *
 * Two values rather than a free-form string, for the same reason Create Video keeps two: a visitor
 * can act on exactly two distinctions, whether the account needs credit and whether retrying could
 * plausibly help. Every reviewed music model is third-party and bills against prepaid AI Gateway
 * credits, so the first case is not hypothetical here — it is the first thing an unfunded account
 * will see.
 *
 * - `insufficient-credit` — the account has no prepaid AI Gateway credit. Retrying cannot help until
 *   it is topped up, and the panel says so rather than inviting a pointless second attempt.
 * - `provider-failure` — the model or provider failed for some other reason. Retrying may work.
 */
export type MusicFailureReason = 'insufficient-credit' | 'provider-failure';

/**
 * What the browser posts to generate a track.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body carrying one rather than ignoring
 * it. It likewise carries no field describing the _output_ — no media type, no duration, no URL —
 * since the server establishes all of those from the bytes it received.
 *
 * The control names here are this demo's own, not any provider's. The per-model wire names live in
 * the descriptor, so a visitor's instrumental toggle becomes `force_instrumental` or
 * `is_instrumental` depending on which model was selected without the browser needing to know
 * either spelling.
 */
export interface GenerateMusicRequest {
  /**
   * Description of the style, mood, and instrumentation to generate.
   */
  prompt: string;
  /**
   * Reviewed model identifier, which must be registered against the `generate-music` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
  /**
   * Whether to generate an instrumental track with no vocals.
   */
  instrumental?: boolean;
  /**
   * Lyrics to sing, for a model that accepts them. Lines are separated by newlines.
   */
  lyrics?: string;
  /**
   * Whether to ask the model to write its own lyrics from the prompt.
   *
   * Only accepted by a model that declares the capability, and never together with
   * {@link GenerateMusicRequest.lyrics}: supplying words _and_ asking for words is a request with
   * two answers, and it is charged for separately.
   */
  generateLyrics?: boolean;
  /**
   * Requested track length in seconds, for a model that accepts one.
   */
  lengthSeconds?: number;
  /**
   * Requested output format, which must be one of the model's declared values.
   */
  format?: string;
  /**
   * Seed for reproducible output, for a model that accepts one.
   */
  seed?: number;
}

/**
 * The settings one track was generated with.
 *
 * Echoed back rather than assumed, so the UI can state what produced a result even after the form
 * has moved on, and so the estimate shown before the request can be compared against what was
 * actually applied.
 *
 * The prompt is echoed because it is the caption of the result — the panel labels a player with
 * what was asked for — but the lyrics deliberately are not. The browser already has them, and a
 * server that returned a visitor's words back to them would put the content in one more place for
 * no benefit. Their length and origin are reported instead.
 */
export interface AppliedMusicControls {
  /**
   * Model identifier that generated the track.
   */
  model: string;
  /**
   * Prompt as sent, after trimming.
   */
  prompt: string;
  /**
   * Whether an instrumental track was requested.
   */
  instrumental: boolean;
  /**
   * Where the lyrics came from; see {@link MusicLyricsSource}.
   */
  lyricsSource: MusicLyricsSource;
  /**
   * How many characters of lyrics were sent, when the caller supplied any.
   */
  lyricsCharacterCount?: number;
  /**
   * Requested length in seconds, including a filled-in default.
   *
   * Absent for a model with no length control. Absence is meaningful and is rendered as such: it
   * means the model chose the length, not that the length is unknown to the panel by accident.
   */
  lengthSeconds?: number;
  /**
   * Output format applied, including a filled-in default.
   */
  format: string;
  /**
   * Seed applied, when the model accepts one and the caller supplied it.
   */
  seed?: number;
  /**
   * The unit this model bills in, so a figure beside it reads honestly.
   */
  pricingUnit: MusicPricing['unit'];
  /**
   * Estimated cost in US dollars, derived from the model's published price.
   *
   * An estimate and labelled as one wherever it is shown. The authoritative figure is the AI
   * Gateway log's, which arrives with the run's metrics; this exists so a visitor knows what a
   * click costs _before_ spending it, which matters here for the same reason it does in Create
   * Video — every model in this panel bills against prepaid credits.
   *
   * It is **never** derived from tokens. Neither reviewed model reports a token count, and
   * inventing one would be the exact misreading this panel exists to correct.
   */
  estimatedCostUsd: number;
  /**
   * One sentence explaining how {@link AppliedMusicControls.estimatedCostUsd} was arrived at.
   *
   * Carried rather than composed in the browser so the explanation and the arithmetic cannot drift
   * apart. "$0.0025 per output second × 30 seconds" and "$0.15 per track plus $0.01 for generated
   * lyrics" are the same field describing two genuinely different billing models.
   */
  costBasis: string;
}

/**
 * The generated track a completed run produced.
 *
 * Carries bytes rather than the provider's URL, deliberately. The URL the model returned points at
 * the provider's own CDN, is short-lived, and would leak the visitor's IP address to a third party
 * the moment the page rendered it. The Worker fetches it once from an allowlisted host, checks the
 * signature of what came back, and returns the audio here.
 */
export interface GeneratedTrack {
  /**
   * The audio bytes, base64-encoded.
   */
  base64: string;
  /**
   * Media type established by inspecting the returned bytes, never by trusting a provider header.
   */
  mediaType: MusicMediaType;
  /**
   * Size of the decoded audio in bytes, so the UI can state it without measuring the payload.
   */
  byteLength: number;
  /**
   * Duration in seconds when it could be read cheaply and correctly from the container.
   *
   * Only WAV carries this reliably in its header. An MP3's duration needs either a constant-bitrate
   * assumption that is wrong for real encoder output or a walk of every frame, so it is left absent
   * and the player reports its own measurement instead. A wrong duration shown beside a player that
   * disagrees with it is worse than no duration — and on this panel it would look like a wrong
   * bill.
   */
  durationSeconds?: number;
  /**
   * The provider host the audio was retrieved from.
   *
   * Reported because the panel makes a claim about it: the original asset is hosted by the provider
   * and may expire. Naming the host is how that disclosure stays concrete rather than generic, and
   * it is published data — it is one of the hosts the catalogue already advertises for the model.
   */
  sourceHost: string;
}

/**
 * What the Generate Music endpoint returns on success.
 */
export interface GenerateMusicResponse {
  /**
   * The generated track; see {@link GeneratedTrack}.
   */
  track: GeneratedTrack;
  /**
   * The run receipt, whose `costStatus` is `pending` whenever a gateway log exists to poll for.
   */
  receipt: RunReceipt;
  /**
   * The controls the server actually applied, including the defaults it filled in and the estimate.
   */
  applied: AppliedMusicControls;
}

/**
 * Estimates what a run will cost before it is made, in US dollars.
 *
 * Exported and shared so the browser's pre-request estimate and the server's reported estimate are
 * one calculation rather than two implementations that can disagree. Both branches are exact rather
 * than approximate — the quantity each model bills on is known before the request, which is unusual
 * and is what makes the comparison worth showing.
 *
 * @param pricing The selected model's published pricing; see {@link MusicPricing}.
 * @param lengthSeconds Requested length in seconds, or `undefined` for a model with no length
 *   control. Ignored by a per-track model, which is the point.
 * @param generateLyrics Whether the model was asked to write the lyrics itself, which a per-track
 *   model charges separately for.
 * @returns The estimate in US dollars. Zero only when a published price really is zero; a model
 *   whose price this demo does not know would be absent from the catalogue rather than quoted at
 *   nothing.
 */
export function estimateMusicCostUsd(
  pricing: MusicPricing,
  lengthSeconds: number | undefined,
  generateLyrics: boolean
): number {
  if (pricing.unit === 'audio-second') {
    // No length means nothing to multiply by, which cannot happen for a per-second model — it has a
    // length control by definition — but returning zero rather than guessing keeps the function
    // total.
    return lengthSeconds === undefined ? 0 : pricing.pricePerOutputSecondUsd * lengthSeconds;
  }

  const lyrics = generateLyrics ? (pricing.pricePerLyricsGenerationUsd ?? 0) : 0;
  return pricing.pricePerTrackUsd + lyrics;
}

/**
 * Describes how an estimate was arrived at, in one sentence.
 *
 * Kept beside the arithmetic it explains, so a change to one is a change to both. The sentence
 * names the unit explicitly because the panel's entire teaching point is that these figures are not
 * comparable to a per-token one.
 *
 * @param pricing The selected model's published pricing.
 * @param lengthSeconds Requested length in seconds, or `undefined` for a model with no length
 *   control.
 * @param generateLyrics Whether the model was asked to write the lyrics itself.
 * @returns The explanation to show beside the figure.
 */
export function describeMusicCostBasis(
  pricing: MusicPricing,
  lengthSeconds: number | undefined,
  generateLyrics: boolean
): string {
  if (pricing.unit === 'audio-second') {
    const seconds = lengthSeconds ?? 0;
    return (
      `$${pricing.pricePerOutputSecondUsd.toFixed(4)} per second of output audio `
      + `× ${seconds} seconds. This model is billed by duration, not by tokens.`
    );
  }

  const lyricsPrice = pricing.pricePerLyricsGenerationUsd;
  const lyricsClause =
    generateLyrics && lyricsPrice !== undefined
      ? ` plus $${lyricsPrice.toFixed(2)} for generating the lyrics`
      : '';

  return (
    `$${pricing.pricePerTrackUsd.toFixed(2)} per track${lyricsClause}, whatever the track's `
    + 'length. This model is billed per track, not by duration and not by tokens.'
  );
}
