/**
 * @file Reviewed model descriptors. These are a hand-checked subset of the Cloudflare unified model
 *   catalog, not a runtime scrape. A scraped catalogue would let a model appear in the UI whose
 *   input contract nobody has read, and would turn this demo into an arbitrary-provider proxy. Each
 *   entry here was read against its catalog page before being added, and its contract is pinned by
 *   `contractVersion`. The types exist from Phase 1 so the catalogue endpoint, the validation
 *   tests, and the inference client all have the shape they need, and so adding a model is filling
 *   in a reviewed form rather than inventing one.
 */

import type { VisionControlSupport } from '../../describe-image';
import type { ImageControlSupport } from '../../images';
import type { RemixImageControlSupport } from '../../remix-image';
import type { TaskId } from '../../tasks';

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
