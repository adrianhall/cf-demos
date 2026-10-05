/**
 * @file Reviewed model descriptors. These are a hand-checked subset of the Cloudflare unified model
 *   catalog, not a runtime scrape. A scraped catalogue would let a model appear in the UI whose
 *   input contract nobody has read, and would turn this demo into an arbitrary-provider proxy. Each
 *   entry here was read against its catalog page before being added, and its contract is pinned by
 *   `contractVersion`. The types exist from Phase 1 so the catalogue endpoint, the validation
 *   tests, and the inference client all have the shape they need, and so adding a model is filling
 *   in a reviewed form rather than inventing one.
 */

import type { AnimateImageControlSupport } from '../../shared/animate-image';
import {
  MAX_CLASSIFICATION_LABELS,
  type ClassificationControlSupport
} from '../../shared/classify-image';
import {
  MAX_TEXT_CLASSIFICATION_LABELS,
  type ReviewedLabel,
  type TextClassificationControlSupport
} from '../../shared/classify-text';
import type { VideoControlSupport } from '../../shared/create-video';
import type { VisionControlSupport } from '../../shared/describe-image';
import type { DetectionControlSupport } from '../../shared/detect-objects';
import type { EvaluationControlSupport } from '../../shared/evaluate-choices';
import {
  MAX_MUSIC_LENGTH_SECONDS,
  MIN_MUSIC_LENGTH_SECONDS,
  type MusicControlSupport
} from '../../shared/generate-music';
import type { ImageControlSupport } from '../../shared/images';
import type { SpeechControlSupport } from '../../shared/read-text';
import type { RemixImageControlSupport } from '../../shared/remix-image';
import {
  MAX_SEMANTIC_SEARCH_PASSAGES,
  type SemanticSearchControlSupport
} from '../../shared/semantic-search';
import type { TaskId } from '../../shared/tasks';
import {
  MAX_INPUT_AUDIO_BYTES,
  type TranscriptionControlSupport
} from '../../shared/transcribe-audio';
import type { TranslationControlSupport, TranslationLanguage } from '../../shared/translate-text';

/**
 * Who runs the model behind a descriptor.
 *
 * Both classes are reached through the same `env.AI.run()` binding and the same AI Gateway; the
 * distinction is shown in the UI because it affects which account prerequisites apply (a
 * third-party model bills through Unified Billing credits).
 */
export type ProviderClass = 'workers-ai' | 'third-party';

/**
 * The unit a provider actually bills in, used purely as a label.
 *
 * The demo never multiplies a unit by a quantity to estimate a price — the cost shown always comes
 * from the AI Gateway log. The unit exists so a figure reads honestly: "per 1M tokens" and "per
 * track" are not comparable numbers, and a UI that implied they were would teach the wrong lesson.
 */
export type PricingUnit =
  | 'token'
  | 'audio-second'
  | 'video-second'
  | 'image'
  | 'track'
  | 'provider-reported';

/**
 * How a model returns its result, which decides the shape of the route serving it.
 */
export type InvocationStyle = 'synchronous' | 'streamed' | 'job';

/**
 * Languages this demo will ask M2M100 to translate between.
 *
 * A **reviewed allowlist, not a transcription.** M2M100 itself handles a hundred languages, and its
 * schema types `source_lang` and `target_lang` as open strings with no enumeration — so there is no
 * provider list to copy and nothing stopping an arbitrary string being forwarded. These are the ISO
 * 639-1 codes this demo has chosen to offer, which keeps the selector usable and means a code
 * reaching the provider is one somebody checked.
 *
 * Declared before the descriptors because both the source and target lists point at it: the model
 * translates in every direction between these, so a second copy would be a second thing to keep in
 * step.
 */
const M2M100_LANGUAGES: readonly TranslationLanguage[] = [
  { code: 'en', name: 'English' },
  { code: 'ar', name: 'Arabic' },
  { code: 'bn', name: 'Bengali' },
  { code: 'zh', name: 'Chinese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'hi', name: 'Hindi' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sw', name: 'Swahili' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'vi', name: 'Vietnamese' }
];

/**
 * Languages IndicTrans2 declares as translation targets.
 *
 * Transcribed from its schema's `target_language` enum, which — unlike M2M100's open string — is
 * genuinely enumerated, so this list is the provider's rather than this demo's. `eng_Latn` is
 * omitted: it is the model's fixed _source_, and offering English as a target would be offering an
 * English-to-English translation.
 *
 * The codes are FLORES-200 style, naming a script as well as a language, which is why three
 * languages appear twice. The display names carry the script so a selector does not show two
 * identical entries.
 */
const INDICTRANS2_LANGUAGES: readonly TranslationLanguage[] = [
  { code: 'hin_Deva', name: 'Hindi (Devanagari)' },
  { code: 'asm_Beng', name: 'Assamese (Bengali)' },
  { code: 'awa_Deva', name: 'Awadhi (Devanagari)' },
  { code: 'ben_Beng', name: 'Bengali (Bengali)' },
  { code: 'bho_Deva', name: 'Bhojpuri (Devanagari)' },
  { code: 'brx_Deva', name: 'Bodo (Devanagari)' },
  { code: 'doi_Deva', name: 'Dogri (Devanagari)' },
  { code: 'gom_Deva', name: 'Konkani (Devanagari)' },
  { code: 'gon_Deva', name: 'Gondi (Devanagari)' },
  { code: 'guj_Gujr', name: 'Gujarati (Gujarati)' },
  { code: 'hne_Deva', name: 'Chhattisgarhi (Devanagari)' },
  { code: 'kan_Knda', name: 'Kannada (Kannada)' },
  { code: 'kas_Arab', name: 'Kashmiri (Arabic)' },
  { code: 'kas_Deva', name: 'Kashmiri (Devanagari)' },
  { code: 'kha_Latn', name: 'Khasi (Latin)' },
  { code: 'lus_Latn', name: 'Mizo (Latin)' },
  { code: 'mag_Deva', name: 'Magahi (Devanagari)' },
  { code: 'mai_Deva', name: 'Maithili (Devanagari)' },
  { code: 'mal_Mlym', name: 'Malayalam (Malayalam)' },
  { code: 'mar_Deva', name: 'Marathi (Devanagari)' },
  { code: 'mni_Beng', name: 'Manipuri (Bengali)' },
  { code: 'mni_Mtei', name: 'Manipuri (Meitei)' },
  { code: 'npi_Deva', name: 'Nepali (Devanagari)' },
  { code: 'ory_Orya', name: 'Odia (Odia)' },
  { code: 'pan_Guru', name: 'Punjabi (Gurmukhi)' },
  { code: 'san_Deva', name: 'Sanskrit (Devanagari)' },
  { code: 'sat_Olck', name: 'Santali (Ol Chiki)' },
  { code: 'snd_Arab', name: 'Sindhi (Arabic)' },
  { code: 'snd_Deva', name: 'Sindhi (Devanagari)' },
  { code: 'tam_Taml', name: 'Tamil (Tamil)' },
  { code: 'tel_Telu', name: 'Telugu (Telugu)' },
  { code: 'urd_Arab', name: 'Urdu (Arabic)' },
  { code: 'unr_Deva', name: 'Mundari (Devanagari)' }
];

/**
 * The complete label set DistilBERT SST-2 can emit.
 *
 * Genuinely complete rather than a reviewed subset, and that is what makes it worth publishing: the
 * model was fine-tuned on SST-2, a binary sentiment corpus, so these two labels are _all_ it can
 * ever return. A visitor can see the entire space of possible answers before submitting anything,
 * which is precisely the property a fixed-label classifier has and a text generator does not.
 *
 * The codes are upper-case because that is exactly how the model emits them; the response is
 * matched against these without case normalisation, so a change in the model's own spelling
 * surfaces as an unrecognised label rather than being quietly absorbed.
 */
const SST2_LABELS: readonly ReviewedLabel[] = [
  { code: 'POSITIVE', name: 'Positive', description: 'The text expresses favourable sentiment.' },
  { code: 'NEGATIVE', name: 'Negative', description: 'The text expresses unfavourable sentiment.' }
];

/**
 * The immutable sentiment choices Classify Text asks Clef Flash to decide between.
 *
 * Clef is normally a decision model: its caller supplies questions and criteria. This is the one
 * narrow, reviewed exception that keeps it a **fixed-label** classifier: these three choices live
 * in the descriptor, never in the request body or the browser, and every run receives exactly this
 * question. The resulting model can be compared honestly with DistilBERT: both choose sentiment,
 * but Clef includes the neutral class SST-2 lacks.
 */
const CLEF_SENTIMENT_LABELS: readonly ReviewedLabel[] = [
  { code: 'POSITIVE', name: 'Positive', description: 'The text expresses favourable sentiment.' },
  { code: 'NEGATIVE', name: 'Negative', description: 'The text expresses unfavourable sentiment.' },
  {
    code: 'NEUTRAL',
    name: 'Neutral',
    description: 'The text is factual, mixed, or expresses no clear sentiment.'
  }
];

/**
 * The Llama Guard 3 hazard taxonomy, as Cloudflare publishes it.
 *
 * Names transcribed from the AI Gateway Guardrails documentation, which publishes the mapping for
 * the codes this model emits. The model returns bare codes, so without this list a result would
 * read `S1` with no indication of what that means.
 *
 * `S14` is included even though that table stops at `S13`, and the two sources disagree for a
 * reason worth knowing. The Guardrails table documents the subset _Guardrails_ evaluates, and says
 * so explicitly: "the Llama Guard 3 category S14 (Code interpreter abuse) is not evaluated by
 * Guardrails." The model can still emit it, and this model's own output schema confirms the range,
 * describing the field as "hazard category classname, from S1 to S14". This panel calls the model
 * directly rather than through Guardrails, so the model's range is the one that applies.
 *
 * A code outside even this list is still reported as unrecognised rather than given a name this
 * demo invented, which is the honest response to a taxonomy that has moved again.
 *
 * These are emphatically **not** general-purpose topic labels, and the panel says so. They are the
 * categories of a content-safety model, and reading "S6 Specialized Advice" as a topic
 * classification would be a serious misreading.
 */
const LLAMA_GUARD_CATEGORIES: readonly ReviewedLabel[] = [
  { code: 'S1', name: 'Violent Crimes' },
  { code: 'S2', name: 'Non-Violent Crimes' },
  { code: 'S3', name: 'Sex-Related Crimes' },
  { code: 'S4', name: 'Child Sexual Exploitation' },
  { code: 'S5', name: 'Defamation' },
  { code: 'S6', name: 'Specialized Advice' },
  { code: 'S7', name: 'Privacy' },
  { code: 'S8', name: 'Intellectual Property' },
  { code: 'S9', name: 'Indiscriminate Weapons' },
  { code: 'S10', name: 'Hate' },
  { code: 'S11', name: 'Suicide & Self-Harm' },
  { code: 'S12', name: 'Sexual Content' },
  { code: 'S13', name: 'Elections' },
  { code: 'S14', name: 'Code Interpreter Abuse' }
];

/**
 * One reviewed model a panel may use.
 */
export interface ModelDescriptor {
  /**
   * Model identifier exactly as `env.AI.run()` expects it.
   */
  id: string;
  /**
   * Human-facing name shown in the model selector.
   */
  name: string;
  /**
   * Whether Cloudflare or a third party runs the model.
   */
  provider: ProviderClass;
  /**
   * The single panel this descriptor belongs to. A model usable for two tasks gets two descriptors,
   * because each panel validates its own narrow request schema.
   */
  task: TaskId;
  /**
   * Monotonic version of the reviewed input/output contract. Bumped whenever the catalog page
   * changes in a way that affects the request this demo builds, so a stale descriptor is detectable
   * rather than silently wrong.
   */
  contractVersion: number;
  /**
   * Billing unit label; see {@link PricingUnit}.
   */
  pricingUnit: PricingUnit;
  /**
   * How the result arrives; see {@link InvocationStyle}.
   */
  invocation: InvocationStyle;
  /**
   * Link to the model's catalog page, shown in the panel so a visitor can check the contract
   * themselves.
   */
  documentationUrl: string;
  /**
   * Context window in tokens, when the model declares one. Used by View Tokens to show how much of
   * a window a prompt consumes, and by panels to reject obviously oversized input early.
   */
  contextWindowTokens?: number;
  /**
   * Which optional controls an image model accepts, and within what ranges.
   *
   * Present only for a text-to-image descriptor. The two reviewed image models differ sharply —
   * different parameter names, different step ceilings, one without dimensions at all — so the
   * capability is declared per model rather than assumed per panel. The UI renders only the
   * controls named here and validation accepts only the controls named here, which is what stops a
   * parameter reaching a provider that never agreed to accept it.
   */
  imageControls?: ImageControlSupport;
  /**
   * How the model names its diffusion-step parameter in the request it expects.
   *
   * Needed because the reviewed models disagree: FLUX calls it `steps` and Stable Diffusion XL
   * calls it `num_steps`. Recording the wire name in the reviewed descriptor keeps the mapping
   * beside the contract it came from, rather than in a conditional inside the request builder.
   */
  stepsParameterName?: 'steps' | 'num_steps';
  /**
   * Whether the model's input schema forbids properties it does not declare.
   *
   * FLUX.1 [schnell] sets `additionalProperties: false`, so sending it any extra field is a request
   * the provider is entitled to reject outright. Its own documentation example passes a `seed` that
   * its schema does not permit, which is precisely the kind of discrepancy worth pinning in a
   * reviewed descriptor rather than discovering in production.
   */
  rejectsUndeclaredParameters?: boolean;
  /**
   * Which optional controls a vision model accepts, and whether it requires a question.
   *
   * Present only for an image-to-text descriptor. The two reviewed vision models disagree about the
   * most basic thing a panel needs to know — whether a question is optional — so it is declared per
   * model rather than assumed per panel.
   */
  visionControls?: VisionControlSupport;
  /**
   * Controls an image-to-image model explicitly supports.
   *
   * Kept separate from text-to-image controls because a source image and mask materially change the
   * contract. A field absent here is never forwarded to the provider.
   */
  remixImageControls?: RemixImageControlSupport;
  /**
   * Result controls a classifier exposes, and whether the model or this application applies them.
   *
   * Present only for an image-classification descriptor. The reviewed classifier's request schema
   * accepts nothing but the image, so its controls are declared as `appliedBy: 'playground'` and
   * are applied to the response. Recording that in the descriptor is what lets the UI describe the
   * controls truthfully instead of implying the model was asked to rank.
   */
  classificationControls?: ClassificationControlSupport;
  /**
   * Controls for structured phrase localisation. Unlike classifiers, this model returns boxes with
   * neither labels nor scores: every box is labelled with the requested target and no score floor
   * exists to forward or apply.
   */
  detectionControls?: DetectionControlSupport;
  /**
   * Which controls a text-to-video model accepts, how it spells them, and what it charges,
   *
   * Present only for a text-to-video descriptor. The reviewed models disagree about the wire name
   * _and_ the spelling of the values for the same conceptual control, so both are declared per
   * model. It also carries the per-second price list, because this is the first panel where a
   * single click can cost several dollars and the UI therefore has to estimate before the request
   * rather than only report after it.
   */
  videoControls?: VideoControlSupport;
  /**
   * Which controls an image-to-video model accepts, how it spells them, and what it charges.
   *
   * Present only for an image-to-video descriptor, and kept separate from `videoControls` because a
   * source image materially changes the contract rather than adding a field to it. Two
   * disagreements here go further than anything Create Video had to express. **The source image has
   * a different wire name in every reviewed model** — `image`, `first_frame_image`, `image_uri`,
   * `image_input` — so the name travels in the descriptor rather than in a conditional. And **the
   * two registered models price in incompatible shapes**: one publishes a per-second rate, the
   * other a price for each exact resolution-and-duration combination that does not reduce to a rate
   * at all. Both shapes are declared, and estimation reads whichever is present rather than
   * converting between them.
   */
  animateImageControls?: AnimateImageControlSupport;
  /**
   * Which controls a music model accepts, how it spells them, and what it charges.
   *
   * Present only for a music-generation descriptor. The disagreement here reaches further than in
   * any earlier panel: the two reviewed models not only name the same conceptual control
   * differently and enumerate completely disjoint output formats, they disagree about whether a
   * requested track length exists at all — and they are **billed in different units**. One charges
   * per second of output audio, the other a flat price per track plus a separate charge for writing
   * lyrics. The pricing therefore travels in the descriptor as a discriminated union rather than as
   * a nullable rate, because the billable quantity itself differs.
   */
  musicControls?: MusicControlSupport;
  /**
   * Which controls a text-to-speech model accepts, how it spells them, and what it charges.
   *
   * Present only for a text-to-speech descriptor. The reviewed models disagree more completely here
   * than in any earlier panel: the two families share _no_ controls at all, and even the text field
   * has a different name in each. Both the wire names and the legal value lists are therefore
   * declared per model, and a field absent here is never forwarded.
   */
  speechControls?: SpeechControlSupport;
  /**
   * How a transcription model carries its audio, which controls it accepts, and what it charges.
   *
   * Present only for an automatic-speech-recognition descriptor. The disagreement here is the
   * widest in the demo: the three reviewed models want the _same bytes_ in three different
   * encodings, return the transcript in three different shapes, and mean different things by a
   * confidence number. The encoding a model demands also decides how large a file it may safely be
   * given, so the size ceiling is declared per model rather than once for the panel.
   */
  transcriptionControls?: TranscriptionControlSupport;
  /**
   * Which languages a translation model accepts, how it spells its controls, and whether it
   * batches.
   *
   * Present only for a translation descriptor. The disagreement that matters most here is not about
   * controls but about **cost shape**: one reviewed model accepts an array of lines in a single
   * call, and the other takes one string, so the same multi-line passage is one paid call or one
   * per line depending on the selection. The other substance is that one model has no source
   * language at all, which is why the panel's swap action exists for one model and cannot exist for
   * the other.
   */
  translationControls?: TranslationControlSupport;
  /**
   * What a text classifier can emit, how it wants its input, and whether it scores anything.
   *
   * Present only for a text-classification descriptor. The disagreement that matters most is not
   * about controls but about **whether there is a score at all**: one reviewed model returns a
   * scored ranking and the other returns a boolean verdict with no confidence for anything. That is
   * why the ranking controls are declared per model rather than assumed, and why the outcome is a
   * discriminated union rather than one shape with optional fields.
   */
  textClassificationControls?: TextClassificationControlSupport;
  /**
   * What a reviewed search model does, and how it must be asked.
   *
   * The browser needs this for something no earlier panel required: `strategy` and `cacheable`
   * decide **what a repeat search costs**. An embedding model's passage vectors are reusable, so
   * searching the same collection again is free; a cross-encoder re-reads every passage against the
   * new query and is charged in full each time. `dimensions` is published before any run because it
   * is the clearest evidence that scores from two models are not comparable — a cosine of 0.7 in a
   * 768-dimension space and in a 2,048-dimension one are unrelated numbers.
   */
  semanticSearchControls?: SemanticSearchControlSupport;
  /**
   * What a reviewed decision model accepts, and what it charges for.
   *
   * The browser needs this for two things no earlier panel required. `supportedQuestionTypes`
   * decides which question types the builder may offer, so an unsupported type is never
   * constructible rather than merely rejected on submit. `contextWindowTokens` is shown beside a
   * live token count of the state — the View Tokens handoff this panel owes — because a large
   * structured state consumes the window quickly and the only honest way to say so is a number.
   */
  evaluationControls?: EvaluationControlSupport;
  /**
   * The field a vision model puts its answer in.
   *
   * Needed because the reviewed models disagree: LLaVA's output schema declares `description` while
   * Llama 3.2 Vision declares `response`. Recording the field name in the reviewed descriptor keeps
   * the mapping beside the contract it came from, rather than leaving the service to guess from a
   * list of candidate keys.
   */
  descriptionField?: 'description' | 'response';
}

/**
 * Every reviewed model, grouped by nothing: panels filter this list by `task`.
 *
 * Two Chat models rather than one, because having something to compare is what makes the cost meter
 * interesting: the same prompt against a 70B and a 3B model produces visibly different latency and
 * a materially different figure in the session total. Both were read against their catalog pages,
 * both accept the `messages` array this demo sends, and both stream.
 */
export const MODEL_DESCRIPTORS: readonly ModelDescriptor[] = [
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    name: 'Llama 3.3 70B (fast)',
    provider: 'workers-ai',
    task: 'chat',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'streamed',
    documentationUrl:
      'https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/',
    contextWindowTokens: 24_000
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    name: 'Llama 3.2 3B',
    provider: 'workers-ai',
    task: 'chat',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'streamed',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/llama-3.2-3b-instruct/',
    contextWindowTokens: 80_000
  },
  // The two image models were chosen because they *disagree*, not in spite of it. One takes a
  // prompt and up to 8 steps and returns base64 JSON; the other takes a negative prompt,
  // dimensions, guidance, and a seed, allows 20 steps, and returns a raw PNG stream. A panel that
  // handles both honestly cannot paper over the difference with a single hardcoded form, which is
  // the lesson worth demonstrating.
  {
    id: '@cf/black-forest-labs/flux-1-schnell',
    name: 'FLUX.1 [schnell]',
    provider: 'workers-ai',
    task: 'create-image',
    contractVersion: 1,
    pricingUnit: 'image',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/',
    imageControls: {
      // Its schema declares `prompt` and `steps` and nothing else. No negative prompt, no
      // dimensions, and — despite the example on its own catalog page — no seed.
      negativePrompt: false,
      seed: false,
      steps: { min: 1, max: 8, step: 1, default: 4 }
    },
    stepsParameterName: 'steps',
    rejectsUndeclaredParameters: true
  },
  {
    id: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
    name: 'Stable Diffusion XL',
    provider: 'workers-ai',
    task: 'create-image',
    contractVersion: 1,
    pricingUnit: 'image',
    invocation: 'synchronous',
    documentationUrl:
      'https://developers.cloudflare.com/workers-ai/models/stable-diffusion-xl-base-1.0/',
    imageControls: {
      negativePrompt: true,
      seed: true,
      dimensions: { min: 256, max: 2_048, step: 64, default: 1_024 },
      steps: { min: 1, max: 20, step: 1, default: 20 },
      guidance: { min: 0, max: 20, step: 0.5, default: 7.5 }
    },
    stepsParameterName: 'num_steps'
  },
  // Default first: FLUX.2 Klein 4B is the fastest and least expensive Cloudflare-hosted member of
  // this editing family. All three share the multipart stream contract and 512px reference limit.
  {
    id: '@cf/black-forest-labs/flux-2-klein-4b',
    name: 'FLUX.2 [klein] 4B',
    provider: 'workers-ai',
    task: 'remix-image',
    contractVersion: 1,
    pricingUnit: 'image',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/',
    remixImageControls: {
      seed: false,
      inputAdapter: 'flux-multipart',
      maxInputEdge: 512,
      outputHosts: []
    }
  },
  {
    id: '@cf/black-forest-labs/flux-2-klein-9b',
    name: 'FLUX.2 [klein] 9B',
    provider: 'workers-ai',
    task: 'remix-image',
    contractVersion: 1,
    pricingUnit: 'image',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/flux-2-klein-9b/',
    remixImageControls: {
      seed: false,
      inputAdapter: 'flux-multipart',
      maxInputEdge: 512,
      outputHosts: []
    }
  },
  {
    id: '@cf/black-forest-labs/flux-2-dev',
    name: 'FLUX.2 [dev]',
    provider: 'workers-ai',
    task: 'remix-image',
    contractVersion: 1,
    pricingUnit: 'image',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/flux-2-dev/',
    remixImageControls: {
      seed: false,
      inputAdapter: 'flux-multipart',
      maxInputEdge: 512,
      outputHosts: []
    }
  },
  {
    id: 'pruna/p-image-edit',
    name: 'P-Image-Edit',
    provider: 'third-party',
    task: 'remix-image',
    contractVersion: 1,
    pricingUnit: 'image',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/ai/models/pruna/p-image-edit/',
    remixImageControls: {
      seed: true,
      inputAdapter: 'pruna-json',
      // This provider currently returns an inline data URI, so no network origin is needed.
      outputHosts: []
    }
  },
  {
    id: 'google/nano-banana-2',
    name: 'Nano Banana 2',
    provider: 'third-party',
    task: 'remix-image',
    contractVersion: 1,
    pricingUnit: 'provider-reported',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/ai/models/google/nano-banana-2/',
    remixImageControls: {
      seed: false,
      inputAdapter: 'nano-banana-json',
      // The Unified Catalog proxies signed Google output through this reviewed Cloudflare host.
      outputHosts: [
        'storage.googleapis.com',
        'generativelanguage.googleapis.com',
        'examples.aig.cloudflare.com',
        'pub-04a6d208d361438ea01b797e6973bd19.r2.dev'
      ]
    }
  },
  // The two vision models disagree more sharply than the image pair did, and again that is why
  // they were chosen. One will caption a bare picture and returns its answer in `description`; the
  // other requires a question, allows twice the answer length, and returns `response`. A panel
  // that handles both honestly has to let the form itself change between "ask a question" and
  // "ask a question, or don't".
  {
    id: '@cf/llava-hf/llava-1.5-7b-hf',
    name: 'LLaVA 1.5 7B',
    provider: 'workers-ai',
    task: 'describe-image',
    contractVersion: 1,
    // Billed per token like the text models, but the input token count is dominated by the image
    // rather than by the question, so the figure moves with picture size more than prompt length.
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/llava-1.5-7b-hf/',
    visionControls: {
      // Its schema requires only `image`; `prompt` is optional. Asked nothing, it captions the
      // picture, which is a genuinely different interaction from the other model's.
      instructionRequired: false,
      maxTokens: { min: 32, max: 1_024, step: 32, default: 512 }
    },
    descriptionField: 'description'
  },
  {
    id: '@cf/meta/llama-3.2-11b-vision-instruct',
    name: 'Llama 3.2 11B Vision',
    provider: 'workers-ai',
    task: 'describe-image',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl:
      'https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/',
    contextWindowTokens: 128_000,
    visionControls: {
      // `prompt` is required with `minLength: 1`, so a bare picture is an invalid request rather
      // than an implied "describe this".
      instructionRequired: true,
      maxTokens: { min: 32, max: 2_048, step: 32, default: 256 }
    },
    descriptionField: 'response'
  },
  // The catalogue currently lists exactly one Cloudflare-hosted image classifier, so this panel has
  // one reviewed model rather than a pair to compare. That is the catalogue's state, not an
  // oversight: adding a text-to-image model here to make the selector look fuller would offer a
  // model that cannot perform the task.
  //
  // Its contract is the narrowest in the demo. The schema is `{ image: number[] }` and nothing
  // else — no top-k, no threshold, no label-set selection — and the output is a bare array of
  // `{ label, score }`. Both facts are pinned here because they decide the shape of the whole
  // panel: the result controls are applied to the response, and the output normaliser expects an
  // array rather than an envelope.
  {
    id: '@cf/microsoft/resnet-50',
    name: 'ResNet-50',
    provider: 'workers-ai',
    task: 'classify-image',
    contractVersion: 1,
    // Billed per inference request rather than per token or per image produced: $0.00000251 a
    // call at review time. The label is what keeps the figure from being read as comparable to a
    // per-token Chat cost; the figure itself always comes from the gateway log.
    pricingUnit: 'provider-reported',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/resnet-50/',
    classificationControls: {
      // ImageNet gives this model 1,000 categories, and it scores a long tail of them. Five is
      // enough to show the shape of a ranking — including the near-miss second place that makes
      // the scores worth looking at — without turning the output column into a wall of noise.
      topK: { min: 1, max: MAX_CLASSIFICATION_LABELS, step: 1, default: 5 },
      // Zero by default, so nothing is hidden until a visitor chooses to hide it. A default floor
      // would quietly suppress the low-confidence guesses that are the most instructive part of a
      // classifier's output.
      minimumConfidence: { min: 0, max: 1, step: 0.01, default: 0 },
      // The model's schema has no ranking fields at all, so these are applied to its response.
      appliedBy: 'playground'
    }
  },
  // Moondream's dedicated detect mode is the sole reviewed detector: LLaVA and Llama Vision only
  // offer prose, and parsing prose into geometry would be unsafe and dishonest (Llama also needs a licence).
  {
    id: '@cf/moondream/moondream3.1-9B-A2B',
    name: 'Moondream 3.1 9B A2B',
    provider: 'workers-ai',
    task: 'detect-objects',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/',
    detectionControls: {
      target: { required: true },
      maxObjects: { min: 1, max: 500, step: 1, default: 150 },
      appliedBy: 'model',
      scoreFloor: false
    }
  },
  // Every text-to-video model in the catalogue is third-party, so this panel inherits the prepaid
  // AI Gateway credit prerequisite that Remix Image already discloses. All of them also return a
  // short-lived URL on the provider's own host rather than bytes, and all of them report only
  // `state: "Completed"` — there is no provider job handle to poll, which is why the job this panel
  // reports on is this demo's own Workflow.
  //
  // PixVerse v6 is the default because it is by far the cheapest way to see the panel work: 360p
  // runs at $0.025 a second against Alibaba's $0.28 at 1080p, an elevenfold difference for the same
  // click. Defaulting to the expensive model would make the first exploratory run the costly one.
  {
    id: 'pixverse/v6',
    name: 'PixVerse v6',
    provider: 'third-party',
    task: 'create-video',
    contractVersion: 1,
    // Billed per second of output, and the rate varies with resolution and whether audio is
    // generated. The label keeps the figure from being read as comparable to a per-token Chat cost.
    pricingUnit: 'video-second',
    invocation: 'job',
    documentationUrl: 'https://developers.cloudflare.com/ai/models/pixverse/v6/',
    videoControls: {
      resolutionParameterName: 'quality',
      resolutions: ['360p', '540p', '720p', '1080p'],
      // The cheapest option, not the model's own 720p default. One click here can cost real money,
      // so the default is the one a visitor would pick if they knew the price list.
      defaultResolution: '360p',
      aspectParameterName: 'aspect_ratio',
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '2:3', '3:2', '21:9'],
      defaultAspectRatio: '16:9',
      durationRange: { min: 1, max: 15, step: 1, default: 5 },
      // Short by default for the same reason the resolution is low: duration is the other half of
      // the price multiplication.
      defaultDuration: 5,
      seed: true,
      negativePrompt: true,
      audioParameterName: 'generate_audio',
      // Audio costs more per second, and this panel shows an estimate before the request, so the
      // silent rates are the honest baseline to quote. The gateway log remains authoritative.
      pricePerSecondUsd: { '360p': 0.025, '540p': 0.035, '720p': 0.045, '1080p': 0.09 },
      // PixVerse serves finished renders from its own media CDN. `examples.aig.cloudflare.com` is
      // included because the catalogue proxies its documentation examples through that host, which
      // is what a first exploratory call against the Unified Catalog can return.
      outputHosts: ['media.pixverse.ai', 'examples.aig.cloudflare.com']
    }
  },
  // Alibaba HappyHorse 1.1 is the comparison model, and it disagrees with PixVerse in exactly the
  // ways that make a per-model descriptor necessary rather than decorative: it names its resolution
  // control `resolution` instead of `quality` and spells the values `720P` rather than `720p`, names
  // its aspect control `ratio`, starts its duration range at 3 rather than 1, and generates no audio
  // at all. A panel with one hardcoded form could not drive both.
  {
    id: 'alibaba/hh1.1-t2v',
    name: 'HappyHorse 1.1',
    provider: 'third-party',
    task: 'create-video',
    contractVersion: 1,
    pricingUnit: 'video-second',
    invocation: 'job',
    documentationUrl: 'https://developers.cloudflare.com/ai/models/alibaba/hh1.1-t2v/',
    videoControls: {
      resolutionParameterName: 'resolution',
      // Uppercase, exactly as its schema enumerates them. A provider validating against an enum
      // treats `720p` and `720P` as different strings, so the spelling is pinned here rather than
      // normalised somewhere in the request builder.
      resolutions: ['720P', '1080P'],
      defaultResolution: '720P',
      aspectParameterName: 'ratio',
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      defaultAspectRatio: '16:9',
      durationRange: { min: 3, max: 15, step: 1, default: 5 },
      defaultDuration: 5,
      seed: true,
      negativePrompt: false,
      // No audio parameter in its schema, so the control is absent rather than false — the panel
      // will not offer it and the request builder has nothing to forward.
      pricePerSecondUsd: { '720P': 0.14, '1080P': 0.18 },
      // Alibaba's output reaches this demo through the catalogue's own hosts rather than from a
      // model-studio domain, and the R2 public host is the one its catalogue examples use.
      outputHosts: ['examples.aig.cloudflare.com', 'pub-04a6d208d361438ea01b797e6973bd19.r2.dev']
    }
  },
  // Animate Image. **Re-confirmed at delivery: there is no Cloudflare-hosted image-to-video model,
  // and no Image-to-Video task type exists in the Workers AI catalogue at all.** `cf ai models
  // list` returns ten task types — Automatic Speech Recognition, Dumb Pipe, Image Classification,
  // Image-to-Text, Text Classification, Text Embeddings, Text Generation, Text-to-Image,
  // Text-to-Speech, and Translation. Image-to-Video is not among them. The phase text asked for
  // this to be rechecked in case a hosted model had appeared and the phase could move earlier; it
  // has not, so both models below are third-party and bill against prepaid AI Gateway credits,
  // exactly as Create Video and Remix Image already disclose.
  //
  // This panel is a **top-level panel sharing Create Video's implementation, not a mode inside
  // it**: the same R2 bucket, the same Workflow, the same derived-instance-ID ownership scheme,
  // the same `MediaJob` states, and the same credit-failure classification. It adds no second
  // storage product and no parallel job mechanism. What it does *not* share is the tab.
  //
  // The two models disagree in a way that is this phase's teaching point rather than an
  // inconvenience, and every item below was captured live from each provider's validator — schema
  // validation runs *before* billing, so the full input contract was mapped at zero cost:
  //
  // - **The source image has a different name in every model.** `image` here,
  //   `first_frame_image` for MiniMax, and — in the two models considered and not registered —
  //   `image_uri` for Lightricks and `image_input` for Runway. One concept, four spellings. A
  //   hardcoded request shape could drive exactly one of them.
  // - **Every model types the image as a URI, never as raw bytes.** `alibaba/hh1.1-i2v` rejects a
  //   non-URL value with `Invalid value at image: Invalid URL`. A `data:` URI *is* accepted, which
  //   was verified directly: a probe carrying one passed validation and reached billing (`402`).
  //   That is what lets Phase 8's Finding 10 stand unchanged — the picture travels in the request
  //   and is never persisted. `lightricks/ltx-2-5-fast` is **not registered** precisely because it
  //   refuses a data URI with `Must be an HTTPS URL`, which would require publishing a visitor's
  //   picture at a fetchable address.
  // - **The resolution enums share no value at all**: `720P`/`1080P` against `768P`/`1080P`.
  //   Switching model resets the resolution rather than carrying over a string the other rejects.
  // - **One takes a duration range and the other exactly two lengths.** Alibaba accepts any
  //   integer from 3 to 15; MiniMax accepts 6 or 10 and rejects 3, 4, 5, 8, and 12.
  // - **The prompt is optional for one and required for the other.** Alibaba animates a picture
  //   with no prompt; MiniMax requires one.
  // - **They price in incompatible shapes.** Alibaba publishes a flat per-second rate. MiniMax
  //   publishes $0.28 for six seconds and $0.56 for ten at 768P — 4.67¢ and 5.6¢ a second — which
  //   does not reduce to a rate, so its prices are declared per exact combination and an
  //   unpublished combination is reported as unknown rather than interpolated.
  //
  // `pruna/p-video-animate` was probed and **deliberately skipped**: it requires both `video` and
  // `image`, making it a motion-transfer model rather than an image-to-video one. It animates a
  // picture *using an existing video's* motion, which is a different task from this panel's.
  //
  // HappyHorse 1.1 I2V is the default, and the choice is editorial as well as practical: it is the
  // direct counterpart to Create Video's `alibaba/hh1.1-t2v`, same vendor and same control
  // vocabulary, so the panel's reuse of the Phase 8 descriptor shape is immediately visible when
  // the two are read side by side.
  {
    id: 'alibaba/hh1.1-i2v',
    name: 'HappyHorse 1.1 I2V',
    provider: 'third-party',
    task: 'animate-image',
    contractVersion: 1,
    pricingUnit: 'video-second',
    invocation: 'job',
    documentationUrl: 'https://developers.cloudflare.com/ai/models/alibaba/hh1.1-i2v/',
    animateImageControls: {
      imageParameterName: 'image',
      // Verified live: a `data:` URI passes this model's validator and reaches billing. A non-URL
      // string is refused with `Invalid value at image: Invalid URL`.
      imageDelivery: 'data-uri',
      // Its own usage example animates a picture with no prompt at all, and a probe carrying only
      // the image reached billing rather than being refused.
      motionPromptRequired: false,
      // Uppercase, exactly as its schema enumerates them, matching its t2v sibling. A provider
      // validating against an enum treats `720p` and `720P` as different strings.
      resolutions: ['720P', '1080P'],
      defaultResolution: '720P',
      // Probed at both ends: `duration: 2` is refused with `Too small: expected number to be >=3`
      // and `duration: 999` with `Too big: expected number to be <=15`.
      durationRange: { min: 3, max: 15, step: 1, default: 5 },
      // Short by default for the same reason the resolution is the cheaper one: duration is the
      // other half of the price multiplication, and one click here spends real money.
      defaultDuration: 5,
      seed: true,
      negativePrompt: true,
      pricePerSecondUsd: { '720P': 0.14, '1080P': 0.18 },
      // The catalogue page's own example serves from the AI examples host, and the R2 public host
      // is the one Alibaba's catalogue output uses — the same pair as its t2v sibling.
      outputHosts: ['examples.aig.cloudflare.com', 'pub-04a6d208d361438ea01b797e6973bd19.r2.dev']
    }
  },
  {
    id: 'minimax/hailuo-2.3',
    name: 'MiniMax Hailuo 2.3',
    provider: 'third-party',
    task: 'animate-image',
    contractVersion: 1,
    pricingUnit: 'video-second',
    invocation: 'job',
    documentationUrl: 'https://developers.cloudflare.com/ai/models/minimax/hailuo-2.3/',
    animateImageControls: {
      // The whole reason this descriptor field exists. MiniMax frames the picture as the clip's
      // first frame rather than as "the image", and its validator accepts no other spelling.
      imageParameterName: 'first_frame_image',
      // Verified live, exactly as for Alibaba: a probe carrying a `data:` URI reached billing.
      imageDelivery: 'data-uri',
      // `prompt` is required by its schema; a probe omitting it is refused.
      motionPromptRequired: true,
      // `768P`, not `720P`. The two registered models share no resolution value, which is why the
      // panel resets the control when the model changes rather than carrying the string across.
      resolutions: ['768P', '1080P'],
      defaultResolution: '768P',
      // Exactly two lengths, verified one value at a time: 6 and 10 are accepted while 3, 4, 5, 8,
      // and 12 are each refused with `Invalid value at duration: Invalid input`. This is the fixed
      // -set form of the control rather than a range, and declaring it as a range would offer
      // durations the provider rejects.
      durationChoices: [6, 10],
      defaultDuration: 6,
      // Its schema declares no seed field; sending one would be an undeclared property.
      seed: false,
      negativePrompt: false,
      // Per *combination*, not per second, and that is a genuine property of the published price
      // list rather than a modelling preference: $0.28 at six seconds and $0.56 at ten works out
      // at 4.67¢ and 5.6¢ a second. The catalogue publishes no ten-second 1080P figure, so that
      // combination is deliberately absent and the panel reports its estimate as unknown instead
      // of inventing one.
      priceByCombinationUsd: {
        '768P@6': 0.28,
        '768P@10': 0.56,
        '1080P@6': 0.49
      },
      // MiniMax serves finished renders from its own CDN; the examples host appears for the same
      // reason it does elsewhere, since a first exploratory call can return a proxied example.
      outputHosts: ['video-product.cdn.minimax.io', 'examples.aig.cloudflare.com']
    }
  },
  // Generate Music. **Re-confirmed at delivery: the Workers AI catalogue contains no music model
  // at all.** `cf ai models list` returns 69 Cloudflare-hosted models across ten task types —
  // Automatic Speech Recognition, Image Classification, Image-to-Text, Text Classification, Text
  // Embeddings, Text Generation, Text-to-Image, Text-to-Speech, Translation, and one Dumb Pipe —
  // and no Music Generation type exists among them. A search for "music" matches nothing. That is
  // the catalogue's state rather than an oversight, and it is the whole reason this phase sits after
  // every credit-free panel: both options below are third-party and bill against prepaid AI Gateway
  // credits, exactly as Create Video and Remix Image already disclose.
  //
  // These two models disagree more completely than any other pair in this demo, and the
  // disagreement is the panel's subject rather than an inconvenience:
  //
  // - **The billing units differ.** ElevenLabs charges per second of output audio; MiniMax charges a
  //   flat price per track and a separate price for writing lyrics. Neither is a token. A session
  //   meter that folded a per-track charge into a per-token total would be arithmetically fine and
  //   conceptually wrong.
  // - **One has a length control and the other genuinely cannot.** `music_length_ms` is required for
  //   ElevenLabs when no composition plan is given; MiniMax has no length field whatsoever and its
  //   schema sets `additionalProperties: false`, so sending `duration` is a *rejected* request.
  // - **The instrumental flag has two names**: `force_instrumental` against `is_instrumental`.
  // - **The output-format enums share no value at all**: `mp3_44100_128` against `mp3`.
  //
  // Both are synchronous. Neither schema declares a job handle, a polling endpoint, or an operation
  // identifier, and both document the same envelope — `{ state: "Completed", result: { audio } }` —
  // returned from the call itself. The phase brief asked for the job infrastructure to be reused
  // *only* if the selected model is asynchronous, and it is not, so this panel is a plain
  // request/response like Read Text rather than a Workflow like Create Video.
  //
  // ElevenLabs Music v2 is the default because it is two orders of magnitude cheaper to explore: a
  // thirty-second track costs $0.075 against MiniMax's $0.15 flat charge for any length, and a
  // ten-second sketch costs two and a half cents. Defaulting to the per-track model would make every
  // exploratory run cost the same as the longest one.
  {
    id: 'elevenlabs/music-v2',
    name: 'ElevenLabs Music v2',
    provider: 'third-party',
    task: 'generate-music',
    contractVersion: 1,
    // Billed per second of generated audio, which is why this panel can quote an exact figure
    // before the request: the visitor chooses the duration.
    pricingUnit: 'audio-second',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/ai/models/elevenlabs/music-v2/',
    musicControls: {
      instrumentalParameterName: 'force_instrumental',
      // Optional in its schema, so it is sent only when the caller chose a value.
      instrumentalParameterRequired: false,
      // No lyrics field at all. Vocals are described in the prompt, and because the schema sets
      // `additionalProperties: false` a `lyrics` field would be a rejected request rather than an
      // ignored one — so the panel refuses it with a message naming the model.
      lyrics: 'unsupported',
      lengthParameterName: 'music_length_ms',
      lengthUnit: 'milliseconds',
      // The panel works in whole seconds because that is what a person chooses; the provider takes
      // milliseconds. Its own range is 3,000–600,000 ms. The upper bound here is this demo's,
      // not the provider's: see MAX_MUSIC_LENGTH_SECONDS for why ten minutes of base64 audio in a
      // JSON response is not a thing this panel should relay.
      lengthSeconds: {
        min: MIN_MUSIC_LENGTH_SECONDS,
        max: MAX_MUSIC_LENGTH_SECONDS,
        step: 1,
        // Short by default, for the same reason Create Video defaults to its cheapest settings:
        // duration is the entire price multiplication here, and a default that quietly selected two
        // minutes would make a first exploratory click cost twelve times what it needs to.
        default: 15
      },
      formatParameterName: 'output_format',
      // A reviewed *subset* of its enum rather than a transcription of it. The schema also permits
      // `auto` and five Opus variants; Opus arrives in an Ogg container, which is not in this demo's
      // playback allowlist, so offering it would mean paying for a track the panel then refuses to
      // play. `auto` is excluded because the applied controls report what was asked for, and a value
      // meaning "you decide" could not be reported honestly.
      formats: [
        'mp3_22050_32',
        'mp3_24000_48',
        'mp3_44100_64',
        'mp3_44100_96',
        'mp3_44100_128',
        'mp3_44100_192',
        'mp3_48000_128',
        'mp3_48000_192',
        'mp3_48000_240',
        'mp3_48000_320'
      ],
      // The middle of the list. Format does not affect the price — the charge is per second
      // regardless — so the default is chosen for audible quality against payload size rather than
      // for cost, which is the opposite of how Create Video picks its default.
      defaultFormat: 'mp3_44100_128',
      seed: true,
      // $0.0025 per output audio second at review time.
      pricing: { unit: 'audio-second', pricePerOutputSecondUsd: 0.0025 },
      // Its catalogue examples serve finished tracks from the Unified Catalog's own example host.
      outputHosts: ['examples.aig.cloudflare.com', 'storage.googleapis.com']
    }
  },
  // MiniMax Music 2.6 is the comparison model, and it makes the per-model declaration do visible
  // work in a way no earlier panel's second model has: it disagrees about the *billing unit*, not
  // merely about control names.
  //
  // It has **no length control whatsoever**. Its schema declares `prompt`, `lyrics`, `sample_rate`,
  // `bitrate`, `format`, `lyrics_optimizer`, and `is_instrumental`, sets
  // `additionalProperties: false`, and rejects `duration` as an unsupported field. The model decides
  // how long the track is, and the price is the same either way — which is why a one-minute track
  // costs exactly what the per-second model charges for a minute, and a two-minute track costs half
  // as much per second.
  //
  // It is also the only reviewed model that can write its own lyrics, charges separately for doing
  // so, and **does not return the words**. The response carries an audio URL and nothing else, so
  // the panel states that generated lyrics exist only in the recording rather than rendering an
  // empty lyrics panel.
  {
    id: 'minimax/music-2.6',
    name: 'MiniMax Music 2.6',
    provider: 'third-party',
    task: 'generate-music',
    contractVersion: 1,
    // Billed per finished track. The label is what keeps the figure from being read as comparable
    // either to a per-token Chat cost or to the per-second model beside it in this very panel.
    pricingUnit: 'track',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/ai/models/minimax/music-2.6/',
    musicControls: {
      instrumentalParameterName: 'is_instrumental',
      // Its schema lists `is_instrumental` among its required properties, so it is sent on every
      // request even when it is `false`. Omitting a required boolean is a malformed request, not a
      // defaulted one.
      instrumentalParameterRequired: true,
      lyrics: 'optional',
      lyricsParameterName: 'lyrics',
      lyricsOptimizerParameterName: 'lyrics_optimizer',
      // Required too, for the same reason.
      lyricsOptimizerRequired: true,
      // A documented provider refusal, reimplemented locally so the message names the three ways
      // out of it — supply lyrics, ask the model to write them, or make the track instrumental —
      // and so the refusal happens before anything is charged.
      requiresLyricsForVocals: true,
      // No `lengthParameterName`, no `lengthUnit`, and no `lengthSeconds`. The absence is the
      // contract: there is no length field to forward, and the panel says so rather than offering a
      // control the provider would reject.
      formatParameterName: 'format',
      // Its whole enum, which has no value in common with the model above.
      formats: ['mp3', 'wav'],
      // MP3. A WAV of the same track is roughly ten times larger for no audible gain in a browser,
      // and this payload travels base64-encoded in a JSON response.
      defaultFormat: 'mp3',
      // No seed in its schema.
      seed: false,
      // $0.15 per track plus $0.01 per lyrics generation at review time.
      pricing: {
        unit: 'track',
        pricePerTrackUsd: 0.15,
        pricePerLyricsGenerationUsd: 0.01
      },
      // Its catalogue examples serve finished tracks from MiniMax's own Alibaba Cloud OSS bucket,
      // and the Unified Catalog proxies its documentation examples through the shared example host.
      outputHosts: [
        'minimax-algeng-chat-tts-us.oss-us-east-1.aliyuncs.com',
        'examples.aig.cloudflare.com'
      ]
    }
  },
  // Every reviewed text-to-speech model is Cloudflare-hosted, so this panel carries no prepaid AI
  // Gateway credit prerequisite at all — which is why phase 9 delivers it rather than Animate
  // Image, whose every candidate is third-party.
  //
  // The three models were chosen because they disagree about *everything a panel needs to know*,
  // more completely than any earlier pair. The text field has two different names. The voice
  // controls do not merely differ in range, they are mutually exclusive: Aura publishes a list of
  // named speakers and no language parameter, MeloTTS publishes a language and no speaker
  // parameter. One offers a choice of output format, the other always returns MP3. And they are
  // billed in different units, which decides whether a pre-request estimate is even possible.
  //
  // Aura 2 is the default: it is the current Deepgram generation, the only reviewed model offering
  // a format choice, and billed per character — so the panel can quote an estimate before spending
  // anything, which is the honest thing to do on a panel where a long passage costs real money.
  {
    id: '@cf/deepgram/aura-2-en',
    name: 'Aura 2 (English)',
    provider: 'workers-ai',
    task: 'read-text',
    contractVersion: 1,
    // Billed per thousand characters of *input*, which is the one billing unit in this demo whose
    // quantity is known before the request: the visitor has already typed the text.
    pricingUnit: 'provider-reported',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/aura-2-en/',
    speechControls: {
      textParameterName: 'text',
      // Forty speakers in its schema. The full list is carried rather than a curated subset,
      // because the schema validates against an enum and a trimmed list would make a legal request
      // look invalid. They are the reason this panel's voice control is a select rather than a
      // slider.
      voices: [
        'amalthea',
        'andromeda',
        'apollo',
        'arcas',
        'aries',
        'asteria',
        'athena',
        'atlas',
        'aurora',
        'callista',
        'cora',
        'cordelia',
        'delia',
        'draco',
        'electra',
        'harmonia',
        'helena',
        'hera',
        'hermes',
        'hyperion',
        'iris',
        'janus',
        'juno',
        'jupiter',
        'luna',
        'mars',
        'minerva',
        'neptune',
        'odysseus',
        'ophelia',
        'orion',
        'orpheus',
        'pandora',
        'phoebe',
        'pluto',
        'saturn',
        'thalia',
        'theia',
        'vesta',
        'zeus'
      ],
      // The model's own documented default, so an unchanged form produces the output its catalogue
      // page describes.
      defaultVoice: 'luna',
      // No `languages`: this descriptor is the English model, and the language is a property of the
      // model rather than a parameter. Declaring an empty list would imply a control exists.
      formats: ['mp3', 'wav'],
      // MP3 by default. A WAV of the same speech is roughly ten times larger for no audible gain
      // in a browser, and this payload travels base64-encoded in a JSON response.
      defaultFormat: 'mp3',
      // $0.03 per 1,000 characters at review time.
      pricePerThousandCharactersUsd: 0.03
    }
  },
  // The previous Aura generation, kept as the comparison within the same family: same contract
  // shape, a different and smaller speaker list, and half the price. It is the cleanest
  // demonstration in the demo that a "newer model" choice is a cost decision as much as a quality
  // one — the two differ by a factor of two for the same text.
  {
    id: '@cf/deepgram/aura-1',
    name: 'Aura 1',
    provider: 'workers-ai',
    task: 'read-text',
    contractVersion: 1,
    pricingUnit: 'provider-reported',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/aura-1/',
    speechControls: {
      textParameterName: 'text',
      // Twelve speakers rather than Aura 2's forty, and only partially overlapping: `angus`,
      // `perseus`, `helios`, and `stella` exist only here. A voice valid for one model is therefore
      // invalid for the other, which is precisely why the panel resets the control on model change.
      voices: [
        'angus',
        'asteria',
        'arcas',
        'orion',
        'orpheus',
        'athena',
        'luna',
        'zeus',
        'perseus',
        'helios',
        'hera',
        'stella'
      ],
      defaultVoice: 'angus',
      formats: ['mp3', 'wav'],
      defaultFormat: 'mp3',
      // $0.015 per 1,000 characters at review time — half of Aura 2.
      pricePerThousandCharactersUsd: 0.015
    }
  },
  // MeloTTS is the model that makes the per-model control declaration do visible work. It shares no
  // control with either Aura: its text field is `prompt`, it selects a voice implicitly from `lang`
  // and exposes no speaker parameter, and it always returns MP3. A panel with one hardcoded form
  // could not drive it.
  //
  // It is also billed per *audio minute* rather than per character, which is why the panel's cost
  // estimate is absent rather than zero when it is selected: the billable quantity does not exist
  // until the audio has been generated. Reporting that honestly is the point of
  // `pricePerThousandCharactersUsd` being optional.
  {
    id: '@cf/myshell-ai/melotts',
    name: 'MeloTTS (multilingual)',
    provider: 'workers-ai',
    task: 'read-text',
    contractVersion: 1,
    pricingUnit: 'audio-second',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/melotts/',
    speechControls: {
      // Not `text`. Its schema declares `prompt` as the required field, and sending `text` instead
      // would be a request missing its only mandatory property.
      textParameterName: 'prompt',
      // No `voices`: the schema has no speaker parameter at all.
      //
      // The language list is the set its documentation names. The schema itself types `lang` as an
      // open string with an `en` default, so this list is a reviewed restriction rather than a
      // transcribed enum — which is the safer direction, since an unlisted code would otherwise be
      // forwarded unchecked.
      languages: ['en', 'es', 'fr', 'zh', 'jp', 'kr'],
      defaultLanguage: 'en',
      // No `formats` and so deliberately no `defaultFormat`: it always answers with MP3, so the
      // panel offers no choice rather than offering one that is ignored. The format the visitor
      // actually received is reported from the sniffed bytes, which is authoritative for every
      // model regardless of what it was asked for.
      //
      // No `pricePerThousandCharactersUsd` either: billed at $0.000205 per audio minute, and the
      // duration is not knowable before generation. The panel states that instead of estimating.
      languageSelectsVoice: true
    }
  },
  // Every reviewed transcription model is Cloudflare-hosted, so this panel carries no prepaid AI
  // Gateway credit prerequisite — the same reason phase 10 follows phase 9 rather than the
  // third-party-only phases.
  //
  // These three disagree more completely than any other set in this demo. They want the *same
  // bytes* in three different encodings; they return the transcript in three different shapes; two
  // report a confidence number and mean different things by it; and they differ in price by a
  // factor of ten. Every one of those differences is visible in the panel.
  //
  // Whisper large v3 turbo is the default: it is the only reviewed model that returns segment
  // timings with per-segment quality figures, it takes the audio as a base64 string rather than
  // expanding it into JSON numbers, and at $0.0005 per audio minute it is the cheapest of the
  // three by an order of magnitude.
  {
    id: '@cf/openai/whisper-large-v3-turbo',
    name: 'Whisper large v3 turbo',
    provider: 'workers-ai',
    task: 'transcribe-audio',
    contractVersion: 1,
    pricingUnit: 'audio-second',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/',
    transcriptionControls: {
      // Its schema declares `audio` as `anyOf: [string (base64), { body, contentType }]`. The
      // base64 branch is chosen because it is one copy of the data rather than an expansion of it.
      audioEncoding: 'base64',
      maxAudioBytes: MAX_INPUT_AUDIO_BYTES,
      // ISO 639-1 codes. A reviewed restriction rather than a transcribed enum: the schema types
      // `language` as an open string, so an unlisted code would otherwise be forwarded unchecked.
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'zh', 'ko', 'ru', 'ar', 'hi'],
      // No `supportsLanguageDetection`: Whisper detects the language by default and has no flag to
      // ask it to. That is a different thing from Nova 3's explicit `detect_language`, so the
      // absence is recorded rather than approximated.
      //
      // No `supportsDiarization` and no `supportsPunctuation`: its schema declares neither. It
      // punctuates as part of its output, which is a capability rather than a control.
      supportsContextPrompt: true,
      // The only reviewed model returning `segments[]` with start/end ranges, which is why it is
      // the default: phrase-level timings are the useful granularity for reading a transcript.
      timestampGranularity: 'segment',
      // `avg_logprob`, not a probability. Negative and unbounded below, so the panel must not draw
      // it as a proportion — see `ConfidenceScale`.
      confidenceScale: 'log-probability',
      // $0.0005 per audio minute at review time.
      pricePerAudioMinuteUsd: 0.000_5
    }
  },
  // Nova 3 is the model that makes the per-model declaration do visible work. It shares almost
  // nothing with the Whisper family: the audio must be an `{ body, contentType }` object rather
  // than a string, the transcript is buried three levels deep in
  // `results.channels[0].alternatives[0]`, and it is the only reviewed model that can label
  // speakers or be asked to punctuate.
  //
  // It is also ten times the price of turbo, which is the most instructive fact in this panel's
  // selector: diarization and a genuine confidence number are not free.
  {
    id: '@cf/deepgram/nova-3',
    name: 'Nova 3',
    provider: 'workers-ai',
    task: 'transcribe-audio',
    contractVersion: 1,
    pricingUnit: 'audio-second',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/nova-3/',
    transcriptionControls: {
      // Its schema requires an object with *both* `body` and `contentType`. Sending a bare string
      // is a request missing its only mandatory property, so the sniffed media type is not merely
      // a safety check here — it is a required field of the request.
      audioEncoding: 'body-object',
      maxAudioBytes: MAX_INPUT_AUDIO_BYTES,
      // BCP-47 tags, not ISO 639-1. `en-GB` is valid here and invalid for Whisper, which is the
      // clearest demonstration in the panel that a language code is a per-model contract rather
      // than a universal identifier.
      languages: ['en', 'en-GB', 'en-US', 'es', 'fr', 'de', 'it', 'pt', 'pt-BR', 'nl', 'ja', 'hi'],
      supportsLanguageDetection: true,
      supportsDiarization: true,
      supportsPunctuation: true,
      // No `supportsContextPrompt`: it has `keyterm` and `keywords`, which are a different
      // contract from a free-text prompt. Offering this panel's context-prompt control for Nova 3
      // would mean silently sending the text to a field with different semantics.
      timestampGranularity: 'word',
      // A genuine confidence in [0, 1], which is why this is the one model whose numbers the panel
      // may legitimately draw as proportions.
      confidenceScale: 'probability',
      // $0.0052 per audio minute over regular HTTP at review time. Its WebSocket rate is higher
      // again; this demo only ever makes HTTP calls, so the HTTP figure is the honest one.
      pricePerAudioMinuteUsd: 0.005_2
    }
  },
  // The original Whisper, included for the encoding it demands rather than for its quality. Its
  // schema has no `audio` string branch at all: the only object form is `{ audio: number[] }`, one
  // JSON number per byte.
  //
  // That is why this panel declares its size ceiling per model. A 4 MiB file becomes an array of
  // four million small integers, and the measurements recorded for Describe Image's 1 MiB cap show
  // what that costs in a 128 MB isolate. The lower limit here is a property of the contract, not an
  // arbitrary restriction, and the panel says so when this model is selected.
  //
  // Reviewed *instead of* `@cf/openai/whisper-tiny-en`, which the plan listed. That model is marked
  // Beta and publishes no price at all, and a panel whose whole point is comparing cost per audio
  // minute cannot honestly include a model with no rate.
  {
    id: '@cf/openai/whisper',
    name: 'Whisper (original)',
    provider: 'workers-ai',
    task: 'transcribe-audio',
    contractVersion: 1,
    pricingUnit: 'audio-second',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/whisper/',
    transcriptionControls: {
      audioEncoding: 'byte-array',
      // One quarter of the ceiling. Describe Image measured ~55 MB peak for a 1 MiB payload
      // expanded this way and ~234 MB for 4 MiB — past the isolate's 128 MB limit — so this is the
      // largest size that leaves headroom for concurrent requests.
      maxAudioBytes: 1_024 * 1_024,
      // No `languages`: its schema has no language parameter whatsoever. It detects the language
      // and cannot be told one, so the panel offers no hint for it rather than offering a control
      // the provider would reject.
      //
      // No `supportsLanguageDetection` either, for the same reason as turbo: detection is its
      // behaviour rather than a flag.
      //
      // No diarization, punctuation, or context prompt — none are in its schema.
      //
      // Per-word ranges in a `words[]` array, which is a third output shape again.
      timestampGranularity: 'word',
      // No `confidenceScale`: its output schema declares no confidence or log-probability field at
      // all, so the panel reports its spans without any quality figure rather than inventing one.
      //
      // $0.0005 per audio minute at review time — the same rate as turbo, which is itself worth
      // seeing: the newer model is not more expensive.
      pricePerAudioMinuteUsd: 0.000_5
    }
  },
  // Both reviewed translation models are Cloudflare-hosted, so this panel carries no prepaid AI
  // Gateway credit prerequisite. The phase brief noted that any catalogue text-generation model can
  // translate by prompt, and deliberately preferred a hosted dedicated translator — which is what
  // both of these are.
  //
  // `@cf/utter-project/eurollm-9b-it` was a listed candidate and is **not registered**. It is typed
  // Text Generation, not Translation: translating with it means writing a prompt and reading prose
  // back, with no `target_lang` to validate and no way to be sure the reply is a translation rather
  // than a commentary on one. The phase brief asked for a decision with a reason, and the reason is
  // that this panel's entire lesson is the *typed* translation contract — explicit language codes
  // validated against a declared list. A general LLM behind the same selector would teach that
  // those codes are decoration. Its catalogue page also gates access behind a sign-up form, so it
  // could not be relied on from a fresh account.
  //
  // M2M100 is the default: it is the hosted model whose declared task type is Translation, it
  // handles a hundred languages in both directions, and its explicit source/target contract is what
  // this panel's validation is built around.
  {
    id: '@cf/meta/m2m100-1.2b',
    name: 'M2M100 1.2B',
    provider: 'workers-ai',
    task: 'translate-text',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/m2m100-1.2b/',
    translationControls: {
      targetParameterName: 'target_lang',
      sourceParameterName: 'source_lang',
      // A reviewed subset rather than a transcribed enum: the schema types both language fields as
      // open strings with no enumeration, so there is nothing to transcribe and an unlisted code
      // would be forwarded unchecked.
      //
      // ISO 639-1 codes. The model page's own example sends `source_lang: "english"` and
      // `target_lang: "french"` — full English names — while the schema for both fields documents
      // "the language code (e.g. 'en' for English)". The two disagree, and this demo follows the
      // schema, because the schema is the normative contract and a code is what every other panel
      // in this demo means by a language. Worth knowing if a request is ever refused upstream: the
      // fix would be a spelling change in one reviewed place.
      sourceLanguages: M2M100_LANGUAGES,
      targetLanguages: M2M100_LANGUAGES,
      defaultSourceLanguage: 'en',
      defaultTargetLanguage: 'fr',
      // Its synchronous schema declares `text` as a plain `string`, so a multi-line passage costs
      // one call per line. That is the expensive side of this panel's comparison, and the UI states
      // the call count before the request rather than after the bill.
      batchesSegments: false,
      outputField: 'translated_text'
    }
  },
  // IndicTrans2 is the model that makes the per-model declaration do visible work, and it differs
  // from M2M100 in all three ways this panel is about.
  //
  // It has **no source language**: it translates from English only and its schema declares no
  // source field at all, so the swap action genuinely cannot exist for it. It spells its target
  // field `target_language` rather than `target_lang`. And it accepts `string | string[]`, so a
  // twelve-line passage is one paid call rather than twelve — the clearest demonstration in the
  // demo that a model's request shape is a cost decision.
  //
  // The phase brief recorded that this model's catalogue page was unreachable at review time and
  // asked for a re-check before offering it. Re-checked at delivery: the page resolves, its input
  // and output schemas are published, it is Cloudflare-hosted and not beta, and it is priced
  // identically to M2M100.
  {
    id: '@cf/ai4bharat/indictrans2-en-indic-1B',
    name: 'IndicTrans2 (English → Indic)',
    provider: 'workers-ai',
    task: 'translate-text',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl:
      'https://developers.cloudflare.com/workers-ai/models/indictrans2-en-indic-1B/',
    translationControls: {
      targetParameterName: 'target_language',
      // No `sourceParameterName`: the field does not exist in its schema. Declaring the fixed
      // source separately lets the panel label the input side honestly instead of leaving it blank.
      fixedSourceLanguage: { code: 'eng_Latn', name: 'English (Latin)' },
      // Transcribed directly from the schema's enum, which — unlike M2M100's — really is
      // enumerated. FLORES-200 style tags naming a script as well as a language, so the same
      // language can appear twice: Kashmiri in Arabic and Devanagari, Manipuri in Bengali and
      // Meitei, Sindhi in Arabic and Devanagari. The display names carry the script for exactly
      // that reason.
      targetLanguages: INDICTRANS2_LANGUAGES,
      defaultTargetLanguage: 'hin_Deva',
      // `text` is `string | string[]` and the output is one translation per input, so every line
      // travels in a single call.
      batchesSegments: true,
      outputField: 'translations'
    }
  },
  // Both reviewed text classifiers are Cloudflare-hosted, so this panel carries no prepaid AI
  // Gateway credit prerequisite. The phase brief expected that: the hosted options cover the task,
  // and the lesson here is the fixed-label contract rather than model quality.
  //
  // `@cf/baai/bge-reranker-base` was a listed candidate and is **not registered**. The brief asked
  // for it only if the panel could express its contract honestly, and it cannot. Despite being
  // typed Text Classification, it does not classify a text at all: it scores the *relevance between
  // a query and a list of passages*, taking `{ query, contexts[] }` and returning `{ id, score }`
  // pairs indexed into the caller's own array. There is no label set — the "labels" would be the
  // caller's own passages, which is the precise opposite of the fixed-label contract this panel
  // exists to teach, and much closer to Semantic Search in phase 13. Offering it behind a model
  // selector labelled "Classify Text" would teach that a classifier's categories are something a
  // caller supplies.
  //
  // Worth recording separately: the generated platform types for that model are **wrong**. The
  // `Ai_Cf_Baai_Bge_Reranker_Base_Input` interface carries the JSDoc for `query` but omits the
  // field itself, while the published JSON schema lists it as required. Code written against those
  // types would not compile with a `query`, and would fail at the provider without one.
  {
    id: '@cf/huggingface/distilbert-sst-2-int8',
    name: 'DistilBERT SST-2',
    provider: 'workers-ai',
    task: 'classify-text',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/distilbert-sst-2-int8/',
    textClassificationControls: {
      // A genuine classification head: it scores its labels and returns a number for each.
      outcomeKind: 'scored-labels',
      inputShape: 'text',
      labelSetName: 'Sentiment (SST-2)',
      // Two labels, and that is the entire set. A binary classifier makes the closed-set property
      // impossible to miss: whatever is submitted, the answer is one of these two.
      labelSet: SST2_LABELS,
      // Its schema is `{ text }` and nothing else — no ranking fields at all — so both controls
      // below are applied by this application to the response it received.
      topK: { min: 1, max: MAX_TEXT_CLASSIFICATION_LABELS, step: 1, default: 2 },
      // Zero by default, so nothing is hidden until a visitor chooses to hide it. With only two
      // labels the second score is the informative one: a 51/49 split and a 99/1 split are very
      // different answers, and a default floor would hide exactly that distinction.
      minimumConfidence: { min: 0, max: 1, step: 0.01, default: 0 },
      appliedBy: 'playground',
      // A BERT derivative, so 512 tokens. Text beyond it is truncated *by the model*, which
      // returns a confident score for the prefix with nothing in the response to say so. The
      // panel's character limit is set to stay inside this window.
      contextWindowTokens: 512
    }
  },
  // Llama Guard is the model that makes the per-model declaration do visible work, and it differs
  // from DistilBERT in every way this panel is about.
  //
  // Its declared task type is **Text Generation**, not Text Classification — it is a chat model
  // fine-tuned for safety classification, which is why it takes `messages[]` rather than `{ text }`.
  // Most importantly it returns **no scores at all**: a boolean plus a list of violated category
  // codes. There is nothing to rank, nothing to put in a confidence bar, and the ranking controls
  // are therefore refused rather than ignored.
  //
  // The phase brief allowed it only if the panel could present its categories without implying they
  // are general-purpose labels. The panel names the taxonomy wherever a result appears, and the
  // categories carry their published names, so a result reads as a safety verdict rather than as a
  // topic classification.
  {
    id: '@cf/meta/llama-guard-3-8b',
    name: 'Llama Guard 3 8B',
    provider: 'workers-ai',
    task: 'classify-text',
    contractVersion: 1,
    // Priced per token in both directions, unlike DistilBERT's input-only rate: it generates its
    // answer rather than scoring a head, which is the same fact as `inputShape: 'messages'` seen
    // from the billing side.
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/llama-guard-3-8b/',
    textClassificationControls: {
      // A verdict, not a ranking. The output schema declares `{ safe, categories[] }` with no score
      // field anywhere, so there is no number this panel could honestly put in a bar.
      outcomeKind: 'verdict',
      // A chat model underneath, so the text travels as a single user message.
      inputShape: 'messages',
      // **Required, and missed on the first delivery of this panel.** Its output schema declares
      // `response` as `string | { safe, categories }` without saying what selects between them,
      // and the default turns out to be the string: asked plainly, the model answers with the
      // literal text "\n\nsafe". Sending `response_format: { type: 'json_object' }` — a field its
      // input schema declares but its usage examples never show — is what produces the structured
      // branch. Verified against the live model: without it every run of this model failed,
      // because this application refuses to parse a safety verdict out of prose.
      requiresJsonResponseFormat: true,
      labelSetName: 'Llama Guard 3 hazard taxonomy',
      labelSet: LLAMA_GUARD_CATEGORIES,
      // No `topK` and no `minimumConfidence`: both are meaningless without scores, and validation
      // refuses them for this model rather than accepting and dropping them.
      appliedBy: 'playground',
      // A Llama 3.1 derivative, so the window is far larger than this panel's character limit and
      // truncation is not a concern for it.
      contextWindowTokens: 131_072
    }
  },
  // Clef Flash demonstrates the deliberately narrow bridge to Evaluate Choices: a decision model
  // can classify text when the *application*, not the caller, owns one immutable choice schema.
  // The three labels below are reviewed descriptor data, never request fields, so this does not
  // weaken the fixed-label boundary this endpoint enforces.
  {
    id: '@cf/cloudflare/clef-flash',
    name: 'Clef Flash (three-way sentiment)',
    provider: 'workers-ai',
    task: 'classify-text',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/clef-flash/',
    textClassificationControls: {
      outcomeKind: 'scored-labels',
      inputShape: 'clef-choice',
      labelSetName: 'Sentiment (reviewed Clef choice)',
      labelSet: CLEF_SENTIMENT_LABELS,
      // Clef produces per-option probabilities itself; it has no top-k request field for choice
      // answers, so the panel's display controls remain application-side just as for DistilBERT.
      topK: { min: 1, max: MAX_TEXT_CLASSIFICATION_LABELS, step: 1, default: 3 },
      minimumConfidence: { min: 0, max: 1, step: 0.01, default: 0 },
      appliedBy: 'playground',
      contextWindowTokens: 65_536
    }
  },
  // Semantic Search. Every field below was read from the model's schema and then verified against
  // the live model with `cf ai run`, because the published envelopes disagree in ways the docs do
  // not mention: bge-m3 answers `{ data, shape, pooling, meta, response }`, qwen3 answers
  // `{ data, shape, usage }`, and EmbeddingGemma answers `{ data, shape }`. Only `data` is common
  // to all three, which is why the reader depends on nothing else.
  {
    id: '@cf/baai/bge-m3',
    name: 'BGE M3 (multilingual)',
    provider: 'workers-ai',
    task: 'semantic-search',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/bge-m3/',
    semanticSearchControls: {
      strategy: 'embedding',
      // Verified: a two-text request returned `shape: [2, 1024]`.
      dimensions: 1_024,
      // Verified deterministic: the same text embedded twice returned bit-identical vectors, so a
      // cached vector is the same answer the model would give rather than an approximation.
      cacheable: true,
      // Verified: a thirteen-text request returned thirteen vectors in one call.
      batchesTexts: true,
      topK: { min: 1, max: MAX_SEMANTIC_SEARCH_PASSAGES, step: 1, default: 5 },
      // No ranking field exists in an embedding model's schema, because the ranking does not
      // happen inside the model at all — this application computes it from the vectors.
      appliedBy: 'playground',
      contextWindowTokens: 8_192
    }
  },
  {
    id: '@cf/google/embeddinggemma-300m',
    // Phase 18 added `(beta)` after the live catalogue changed, then the follow-on deliberately
    // removed it again: models move between beta and GA without notice, so stability baked into a
    // display name is a claim this offline registry cannot keep current. A stale caveat is worse
    // than no caveat; the model ID and reviewed contract remain stable and useful facts.
    name: 'EmbeddingGemma 300M',
    provider: 'workers-ai',
    task: 'semantic-search',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/',
    semanticSearchControls: {
      strategy: 'embedding',
      // A different dimension count from the model above, and that is precisely why it is here:
      // 768 and 1,024 are different spaces, so a cosine of 0.7 in each means unrelated things.
      dimensions: 768,
      cacheable: true,
      batchesTexts: true,
      topK: { min: 1, max: MAX_SEMANTIC_SEARCH_PASSAGES, step: 1, default: 5 },
      appliedBy: 'playground',
      contextWindowTokens: 2_048
    }
  },
  {
    id: '@cf/baai/bge-small-en-v1.5',
    name: 'BGE Small EN v1.5',
    provider: 'workers-ai',
    task: 'semantic-search',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/',
    semanticSearchControls: {
      strategy: 'embedding',
      // The smallest reviewed space, and the third distinct dimension count in this panel. A
      // visitor can run one query against 384, 768, and 1,024 dimensions and watch the numbers
      // change while the ordering largely does not — which is the clearest way to show that the
      // score is a relative position rather than a measurement of anything.
      dimensions: 384,
      cacheable: true,
      batchesTexts: true,
      topK: { min: 1, max: MAX_SEMANTIC_SEARCH_PASSAGES, step: 1, default: 5 },
      appliedBy: 'playground',
      // A BERT derivative, so 512 tokens. MAX_SEMANTIC_SEARCH_PASSAGE_CHARACTERS sits inside it.
      contextWindowTokens: 512
    }
  },
  // The cross-encoder, and the reason this panel has two strategies rather than three embedding
  // models. Phase 12 excluded it from Classify Text because it does not classify a text — it
  // scores the relevance *between* a query and a list of passages, which is exactly this panel's
  // operation.
  //
  // Its generated platform types are wrong: `Ai_Cf_Baai_Bge_Reranker_Base_Input` carries the
  // JSDoc for `query` but omits the field itself, while the published schema requires it. Verified
  // against the live model, which rejects a request without it: "required properties at '/' are
  // 'query,contexts'". The input is therefore built as a plain record in the domain rather than
  // against the generated interface.
  {
    id: '@cf/baai/bge-reranker-base',
    name: 'BGE Reranker Base (cross-encoder)',
    provider: 'workers-ai',
    task: 'semantic-search',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/',
    semanticSearchControls: {
      strategy: 'cross-encoder',
      // No `dimensions`: this model produces no vector at all. It reads the query and a passage
      // together and emits a relevance score directly, which is both why it is more accurate and
      // why nothing it produces can be reused.
      cacheable: false,
      // One call carries the query and every passage together, so a search is always exactly one
      // gateway request regardless of collection size — but it is a request whose *size* grows
      // with the collection, and it recurs on every query rather than once per passage.
      batchesTexts: true,
      topK: { min: 1, max: MAX_SEMANTIC_SEARCH_PASSAGES, step: 1, default: 5 },
      // The only `model` value in the panel. Its schema declares `top_k`, so unlike every
      // embedding model the provider applies the requested result count itself. The response's
      // `totalRanked` reports how many entries the provider actually returned, rather than
      // claiming omitted passages were scored and then hidden. See `buildRerankerInput()`.
      appliedBy: 'model',
      contextWindowTokens: 512,
      // Verified against the live model: a relevant passage scored 0.9845 while two irrelevant
      // ones scored 0.0000374 and 0.0000373. Everything irrelevant collapses onto a floor around
      // 0.00004, so a proportional bar would render every non-match as an identical empty bar —
      // implying the model could not tell them apart when in fact it separated them emphatically.
      collapsesIrrelevantScores: true
    }
  },
  // Evaluate Choices. Both descriptors were verified against the live models with `cf ai run`, and
  // three findings below would each be a runtime failure if guessed rather than checked.
  //
  // 1. The request body carries its own `model` field which must agree with the endpoint. Sending
  //    `"clef"` to the clef-flash endpoint fails with `Unsupported model 'clef'. Use
  //    'clef-flash'.` — hence `requestModelName` rather than deriving it from the identifier.
  // 2. A `score` question's criteria are an **array**, while a `choice` question's are an object.
  //    Sending a score legend as an object fails with `Input should be a valid list`.
  // 3. `noul` answers carry **no confidence field** at all, while `choice` and `score` do. That
  //    asymmetry is modelled in the answer union rather than smoothed over.
  //
  // The catalogue types these as Text Generation, which is exactly the misreading this panel
  // exists to correct: they take a state and a typed question schema, and return calibrated
  // probabilities. There is no prose in either direction.
  {
    id: '@cf/cloudflare/clef',
    name: 'Clef (27B decision model)',
    provider: 'workers-ai',
    task: 'evaluate-choices',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/clef/',
    evaluationControls: {
      requestModelName: 'clef',
      supportedQuestionTypes: ['noul', 'choice', 'score'],
      reportsConfidence: true,
      contextWindowTokens: 65_536,
      // Catalogue figure, for explaining the asymmetric price shape rather than for computing a
      // charge: every verified call reported `output_tokens: 0`, so only the input is billable.
      // The authoritative cost of a run remains the one AI Gateway reports.
      inputPricePerMillionTokens: 0.24
    }
  },
  {
    id: '@cf/cloudflare/clef-flash',
    name: 'Clef Flash (9B decision model)',
    provider: 'workers-ai',
    task: 'evaluate-choices',
    contractVersion: 1,
    pricingUnit: 'token',
    invocation: 'synchronous',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/clef-flash/',
    evaluationControls: {
      requestModelName: 'clef-flash',
      supportedQuestionTypes: ['noul', 'choice', 'score'],
      reportsConfidence: true,
      contextWindowTokens: 65_536,
      // Roughly a third of Clef's price for the same question schema, which is the latency and
      // cost trade-off this panel lets a visitor run twice and compare. The same model also
      // appears in Classify Text under an immutable application-owned schema; here the schema is
      // the caller's, which is the entire difference between the two panels.
      inputPricePerMillionTokens: 0.09
    }
  }
];

/**
 * Default model for a panel's selector.
 *
 * Returns the first reviewed descriptor, so the catalogue order doubles as the preference order and
 * there is no second list to keep in step with it.
 *
 * @param task Panel to choose a default for.
 * @returns The panel's first reviewed model, or `undefined` when it has none yet.
 */
export function defaultModelForTask(task: TaskId): ModelDescriptor | undefined {
  return MODEL_DESCRIPTORS.find((model) => model.task === task);
}

/**
 * Lists the reviewed models a panel may use.
 *
 * @param task Panel to list models for.
 * @returns Every descriptor bound to that panel, in catalogue order; empty when the panel has no
 *   reviewed model yet.
 */
export function modelsForTask(task: TaskId): readonly ModelDescriptor[] {
  return MODEL_DESCRIPTORS.filter((model) => model.task === task);
}

/**
 * Looks up a reviewed model by identifier, constrained to one panel.
 *
 * Both arguments are checked together on purpose: accepting a model identifier without also
 * confirming it belongs to the requested panel is how a narrow task API turns into a generic `{
 * model, input }` passthrough.
 *
 * @param task Panel the request was made against.
 * @param modelId Candidate model identifier from an untrusted request.
 * @returns The matching descriptor, or `undefined` when the model is unknown or belongs to a
 *   different panel.
 */
export function findModelForTask(task: TaskId, modelId: string): ModelDescriptor | undefined {
  return MODEL_DESCRIPTORS.find((model) => model.task === task && model.id === modelId);
}
