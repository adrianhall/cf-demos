/**
 * @file The Read Text panel's wire contract. It sits in `src/shared/` beside the other panels'
 *   contracts because both tiers need it, and like them it carries no model descriptors — the
 *   browser learns which models exist and which controls each accepts from `/api/catalogue`. Three
 *   things make this panel's contract different from the panels before it, and all three come from
 *   the reviewed model contracts rather than from a design preference. **The models disagree about
 *   what the text field is called.** Deepgram's Aura models take `text`; MyShell's MeloTTS takes
 *   `prompt`. That is not a cosmetic difference — a provider validating its own schema rejects the
 *   other spelling — so the wire name is declared per model and this contract keeps its own neutral
 *   name. **The models' voice controls are mutually exclusive.** Aura exposes a fixed list of named
 *   speakers and no language control; MeloTTS exposes a language and no speaker at all. There is no
 *   intersection, so a single hardcoded form could not drive both, and a panel that offered a voice
 *   selector for MeloTTS would be offering a control the provider never agreed to accept. **Neither
 *   reviewed model exposes rate or pitch.** The phase brief asks for those controls "when
 *   supported", and the honest answer after reading all three contracts is that none of them
 *   support either. They are therefore declared as optional capabilities that happen to be absent
 *   everywhere, so the UI renders nothing and the server rejects them — rather than being silently
 *   dropped, which would teach a visitor that the control did nothing. Audio is returned
 *   base64-encoded in the JSON response rather than stored. Unlike video, this panel's output is a
 *   few hundred kilobytes, a `<audio>` element can seek freely within a payload the page already
 *   holds, and every reviewed model returns the bytes themselves rather than a short-lived URL on a
 *   provider's host. There is therefore nothing a storage product would buy here, and adding one
 *   would extend this demo's retention surface for no reason — see
 *   `tests/worker/panel-architecture.test.ts`, which holds that boundary.
 */

import type { RunReceipt } from './runs.ts';

/**
 * Longest text the panel will speak, in characters.
 *
 * Chosen against the billing model rather than against a model's input limit, because the billing
 * model is the one that can surprise a visitor. Aura bills per thousand characters, so this cap
 * bounds a single click to a few cents at the most expensive reviewed rate. The server validates
 * every request against it — a browser-side counter is a courtesy, never a control.
 */
export const MAX_SPEECH_CHARACTERS = 2_000;

/**
 * Largest generated audio payload this demo will relay, in bytes.
 *
 * A response bound rather than a storage bound, since the bytes travel base64-encoded in the JSON
 * body. Two thousand characters of speech is comfortably under a megabyte in any reviewed format;
 * eight megabytes leaves generous headroom for uncompressed WAV while still refusing a provider
 * that answered with something far larger than its own contract implies.
 */
export const MAX_SPEECH_BYTES = 8 * 1_024 * 1_024;

/**
 * Media types the panel will play.
 *
 * An allowlist, for the same reason the image panels keep one: the media type decides how a browser
 * treats the bytes, and this payload reaches the page as a `data:` URI. The type is established by
 * inspecting the leading bytes of what the provider actually returned, never by trusting a declared
 * `Content-Type`, so a provider cannot choose how its response is interpreted by this demo's own
 * origin.
 *
 * Deliberately short. Aura's schema also permits `flac`, `mulaw`, `alaw`, and raw `linear16` with
 * no container — all of which are valid provider requests that produce a file a browser will not
 * play. Those are excluded from the reviewed format list rather than offered and then apologised
 * for.
 */
export const PLAYABLE_AUDIO_MEDIA_TYPES = ['audio/mpeg', 'audio/wav'] as const;

/**
 * One media type the panel will play; see {@link PLAYABLE_AUDIO_MEDIA_TYPES}.
 */
export type AudioMediaType = (typeof PLAYABLE_AUDIO_MEDIA_TYPES)[number];

/**
 * Reports whether a value is a media type this panel plays.
 *
 * @param value Candidate media type, sniffed from provider bytes.
 * @returns `true` when the type is in the allowlist.
 */
export function isPlayableAudioMediaType(value: string): value is AudioMediaType {
  return (PLAYABLE_AUDIO_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * File extension to offer when downloading each media type.
 *
 * Derived from the sniffed type rather than from anything the provider declared, so a download's
 * name cannot disagree with its actual bytes.
 */
export const AUDIO_FILE_EXTENSIONS: Readonly<Record<AudioMediaType, string>> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav'
};

/**
 * Reviewed output formats a speech model may be asked for.
 *
 * This demo's own names, not a provider's. Aura spells the choice as two independent fields —
 * `encoding` and `container` — whose legal combinations its documentation describes in prose rather
 * than in its schema. Collapsing the two into one named format means a visitor cannot assemble a
 * pair that is accepted by the provider and then unplayable in the browser, which is the failure
 * this indirection exists to prevent.
 */
export const SPEECH_FORMAT_NAMES = ['mp3', 'wav'] as const;

/**
 * One reviewed output format; see {@link SPEECH_FORMAT_NAMES}.
 */
export type SpeechFormatName = (typeof SPEECH_FORMAT_NAMES)[number];

/**
 * Reports whether a value is a reviewed output format.
 *
 * @param value Candidate format name from an untrusted request.
 * @returns `true` when the name is one this demo will ask for.
 */
export function isSpeechFormatName(value: string): value is SpeechFormatName {
  return (SPEECH_FORMAT_NAMES as readonly string[]).includes(value);
}

/**
 * A numeric control a speech model exposes, with the range the server will accept.
 *
 * Structurally similar to the other panels' range types and deliberately separate from them, for
 * the same reason: sharing one type would couple this panel's published contract to another's, so a
 * later change to an image control would silently alter what this panel advertises.
 *
 * No reviewed model currently declares a control of this shape. The type exists because the panel's
 * brief asks for rate and pitch "when supported", and the answer has to be representable in order
 * to be honestly reported as absent.
 */
export interface SpeechNumericRange {
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
   * Value the model uses when the control is omitted.
   */
  default: number;
}

/**
 * Which controls one speech model supports, how it spells them, and what it charges.
 *
 * Every field beyond the text parameter name is optional, so a model supports nothing it has not
 * explicitly declared. A control absent here is rejected by validation rather than ignored, which
 * is the same direction every other panel in this demo takes.
 */
export interface SpeechControlSupport {
  /**
   * The wire name of the text field, which differs between reviewed models.
   *
   * Deepgram's Aura models declare `text`; MeloTTS declares `prompt`. Recording the wire name in
   * the reviewed descriptor keeps the mapping beside the contract it came from, rather than in a
   * conditional inside the request builder.
   */
  textParameterName: 'text' | 'prompt';
  /**
   * Named voices the model accepts, exactly as its schema enumerates them.
   *
   * Absent for a model with no voice control at all. MeloTTS is such a model: it selects a voice
   * implicitly from the language, so offering a speaker selector for it would be offering a field
   * its schema does not declare.
   */
  voices?: readonly string[];
  /**
   * Voice used when the caller does not choose one.
   */
  defaultVoice?: string;
  /**
   * Language codes the model accepts.
   *
   * Absent for a model whose voice list already determines the language. The two reviewed families
   * are mutually exclusive here — Aura has voices and no language, MeloTTS has a language and no
   * voices — which is precisely why both are declared per model.
   */
  languages?: readonly string[];
  /**
   * Language used when the caller does not choose one.
   */
  defaultLanguage?: string;
  /**
   * Reviewed output formats the model can be asked for.
   *
   * Absent for a model that returns one fixed format. MeloTTS always answers with MP3, so it
   * declares no format control and the panel offers none.
   */
  formats?: readonly SpeechFormatName[];
  /**
   * Format used when the caller does not choose one.
   */
  defaultFormat?: SpeechFormatName;
  /**
   * Whether the model's language choice also determines its voice.
   *
   * Declared so the panel can explain _why_ a model with a language selector has no voice selector,
   * rather than leaving the absence to look like a gap in the UI. MeloTTS is such a model: it picks
   * a speaker from the language and exposes no speaker parameter at all.
   */
  languageSelectsVoice?: boolean;
  /**
   * Speaking rate, when the model exposes one.
   *
   * Absent for every reviewed model. Kept in the contract so the panel's declared capability set
   * can say "this model has no rate control" rather than leaving the question unasked.
   */
  rate?: SpeechNumericRange;
  /**
   * Voice pitch, when the model exposes one. Absent for every reviewed model, as with
   * {@link SpeechControlSupport.rate}.
   */
  pitch?: SpeechNumericRange;
  /**
   * Price in US dollars per thousand characters of input, when the model bills that way.
   *
   * Present so the panel can show an estimate _before_ the request. This is the only reviewed
   * billing model whose cost is knowable in advance: the input length is the billable quantity, and
   * the visitor has already typed it. A model billed per minute of generated audio cannot be
   * estimated this way, declares nothing here, and the panel says so rather than guessing.
   *
   * The figure shown after a run always comes from the AI Gateway log; this is only ever labelled
   * as an estimate.
   */
  pricePerThousandCharactersUsd?: number;
}

/**
 * Every control name a Read Text request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const SPEECH_CONTROL_NAMES = ['voice', 'language', 'format', 'rate', 'pitch'] as const;

/**
 * One optional Read Text control; see {@link SPEECH_CONTROL_NAMES}.
 */
export type SpeechControlName = (typeof SPEECH_CONTROL_NAMES)[number];

/**
 * What the browser posts to have text spoken.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body carrying one rather than ignoring
 * it.
 *
 * The control names here are this demo's own, not any provider's. The per-model wire names live in
 * the descriptor, so a visitor's text becomes `text` or `prompt` depending on which model was
 * selected without the browser needing to know either spelling.
 */
export interface ReadTextRequest {
  /**
   * The text to speak.
   */
  text: string;
  /**
   * Reviewed model identifier, which must be registered against the `read-text` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
  /**
   * Requested voice, which must be one of the model's declared names.
   */
  voice?: string;
  /**
   * Requested language, which must be one of the model's declared codes.
   */
  language?: string;
  /**
   * Requested output format, which must be one the model declares.
   */
  format?: SpeechFormatName;
  /**
   * Requested speaking rate. No reviewed model accepts one, so this is always rejected today; it
   * exists so the rejection is explicit rather than a silently dropped field.
   */
  rate?: number;
  /**
   * Requested voice pitch, rejected for the same reason as {@link ReadTextRequest.rate}.
   */
  pitch?: number;
}

/**
 * The generated speech a completed run produced.
 */
export interface GeneratedSpeech {
  /**
   * The audio bytes, base64-encoded.
   */
  base64: string;
  /**
   * Media type established by inspecting the returned bytes, never by trusting a provider header.
   */
  mediaType: AudioMediaType;
  /**
   * Size of the decoded audio in bytes, so the UI can state it without measuring the payload.
   */
  byteLength: number;
}

/**
 * The settings one run was produced with.
 *
 * Echoed back rather than assumed, so the UI can state what produced a result even after the form
 * has moved on, and so the estimate shown before the request can be compared against what was
 * actually applied.
 */
export interface AppliedSpeechControls {
  /**
   * Model identifier that produced the audio.
   */
  model: string;
  /**
   * How many characters were sent, which is the billable quantity for a character-priced model and
   * the only honest thing to report for any of them.
   *
   * The text itself is deliberately not echoed: the browser already has it, and a server that
   * returned a visitor's content back to them would put it in one more place for no benefit.
   */
  characterCount: number;
  /**
   * Voice applied, including a filled-in default. Absent for a model with no voice control.
   */
  voice?: string;
  /**
   * Language applied, including a filled-in default. Absent for a model with no language control.
   */
  language?: string;
  /**
   * Output format applied, including a filled-in default. Absent for a model with no format
   * control.
   */
  format?: SpeechFormatName;
  /**
   * Estimated cost in US dollars, from the model's published per-character price.
   *
   * Absent for a model this demo cannot estimate — one billed per minute of generated audio, where
   * the billable quantity does not exist until after the request. An absent estimate is reported as
   * absent; it is never filled in with zero, which would read as "free".
   */
  estimatedCostUsd?: number;
}

/**
 * What the Read Text endpoint returns on success.
 */
export interface ReadTextResponse {
  /**
   * The generated audio; see {@link GeneratedSpeech}.
   */
  speech: GeneratedSpeech;
  /**
   * The run receipt, whose `costStatus` is `pending` whenever a gateway log exists to poll for.
   */
  receipt: RunReceipt;
  /**
   * The controls the server actually applied, including the defaults it filled in.
   */
  applied: AppliedSpeechControls;
}

/**
 * Estimates what a run will cost before it is made.
 *
 * Exported and shared so the browser's pre-request estimate and the server's reported estimate are
 * the same calculation rather than two implementations that can disagree by a rounding rule.
 *
 * @param characterCount How many characters will be sent.
 * @param pricePerThousandCharactersUsd The model's published rate, or `undefined` when it does not
 *   bill by character.
 * @returns The estimate in US dollars, or `undefined` when the model's billing model makes a
 *   pre-request estimate impossible. Absence is a meaningful answer here and is rendered as such.
 */
export function estimateSpeechCostUsd(
  characterCount: number,
  pricePerThousandCharactersUsd: number | undefined
): number | undefined {
  if (pricePerThousandCharactersUsd === undefined) {
    return undefined;
  }

  return (characterCount / 1_000) * pricePerThousandCharactersUsd;
}
