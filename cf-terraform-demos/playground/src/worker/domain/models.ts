/**
 * @file Reviewed model descriptors. These are a hand-checked subset of the Cloudflare unified model
 *   catalog, not a runtime scrape. A scraped catalogue would let a model appear in the UI whose
 *   input contract nobody has read, and would turn this demo into an arbitrary-provider proxy. Each
 *   entry here was read against its catalog page before being added, and its contract is pinned by
 *   `contractVersion`. The types exist from Phase 1 so the catalogue endpoint, the validation
 *   tests, and the inference client all have the shape they need, and so adding a model is filling
 *   in a reviewed form rather than inventing one.
 */

import {
  MAX_CLASSIFICATION_LABELS,
  type ClassificationControlSupport
} from '../../shared/classify-image';
import type { VideoControlSupport } from '../../shared/create-video';
import type { VisionControlSupport } from '../../shared/describe-image';
import type { ImageControlSupport } from '../../shared/images';
import type { SpeechControlSupport } from '../../shared/read-text';
import type { RemixImageControlSupport } from '../../shared/remix-image';
import type { TaskId } from '../../shared/tasks';

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
   * Which controls a text-to-video model accepts, how it spells them, and what it charges.
   *
   * Present only for a text-to-video descriptor. The reviewed models disagree about the wire name
   * _and_ the spelling of the values for the same conceptual control, so both are declared per
   * model. It also carries the per-second price list, because this is the first panel where a
   * single click can cost several dollars and the UI therefore has to estimate before the request
   * rather than only report after it.
   */
  videoControls?: VideoControlSupport;
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
    name: 'Stable Diffusion XL (beta)',
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
    name: 'LLaVA 1.5 7B (beta)',
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
