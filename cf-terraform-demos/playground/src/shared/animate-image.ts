/**
 * @file The Animate Image panel's wire contract. Animate Image is a **top-level panel**, not a mode
 *   inside Create Video: a visitor arriving with a picture should find a panel named for what they
 *   want to do rather than discovering it inside a video-generation tab. What the two panels share
 *   is the _implementation_ — the job lifecycle, the R2 bucket, the derived-instance-ID ownership
 *   scheme, the stored-video reader, and the credit-failure path — and that sharing is visible
 *   here: the job states, the stored-video shape, and the failure classification are **imported
 *   from `./create-video.ts` rather than redeclared**, because a second copy of `'accepted' |
 *   'running' | …` would be a second definition of "finished" for one polling loop. Two things are
 *   genuinely this panel's own, and both come from the reviewed model contracts. **The image
 *   parameter has four different names across the candidate models** — `image`,
 *   `first_frame_image`, `image_uri`, and `image_input`. That disagreement is not an inconvenience
 *   to normalise away; it is precisely why the descriptor-driven approach exists, exactly as Create
 *   Video's `quality` against `resolution` was. The visitor supplies "a picture"; the wire name is
 *   read from the descriptor at the last moment. **The source image is bounded more tightly here
 *   than in any other image panel, and the reason is the Workflow rather than the model.** The
 *   picture travels in the request and is never persisted — Phase 8's Finding 10 applies unchanged
 *   — which means it has to cross the Workflow event-parameter boundary, and that boundary is
 *   capped at 1 MiB. Base64 expands bytes by four thirds, so the shared 1 MiB image allowance would
 *   produce a 1.37 MiB payload and the job would fail at creation rather than at validation.
 *   {@link MAX_ANIMATE_SOURCE_BYTES} is the ceiling that keeps an accepted picture actually
 *   startable.
 */

import type { MediaJobState, StoredVideo, VideoFailureReason } from './create-video.ts';
import type { VerifiedImageFacts } from './describe-image.ts';
import type { RunReceipt } from './runs.ts';

/**
 * Largest source picture this panel accepts, in bytes.
 *
 * **This is a Workflow limit wearing an image limit's clothes, and the distinction matters.** Every
 * other image panel accepts up to `MAX_INPUT_IMAGE_BYTES` (1 MiB) because that is what fits
 * comfortably in a base64 JSON request. Here the picture does not stop at the request: it is
 * carried into a Workflow instance as an event parameter, and Workflows cap an event payload at 1
 * MiB (2^20 bytes). Base64 expands bytes by four thirds, so a 1 MiB picture becomes a 1.37 MiB
 * parameter and `create()` rejects the instance — a failure that would arrive _after_ the panel had
 * told the visitor their picture was fine.
 *
 * 640 KiB base64-encodes to roughly 874 KiB, leaving comfortable room for the prompt, the controls,
 * and the verified identity in the same payload. The number is this demo's and not a provider's,
 * which is why it is stated in the panel rather than presented as a model constraint.
 */
export const MAX_ANIMATE_SOURCE_BYTES = 640 * 1_024;

/**
 * Longest motion prompt the panel accepts, in characters.
 *
 * Set to the tightest of the reviewed models' documented limits so the editor's counter means the
 * same thing whichever model is selected: MiniMax caps its prompt at 2,000 characters and Alibaba
 * publishes no limit, so the lower bound governs. The server still validates per request — a
 * browser limit is a courtesy, never a control.
 */
export const MAX_MOTION_PROMPT_CHARACTERS = 2_000;

/**
 * The wire name a reviewed model gives its source-image parameter.
 *
 * Four spellings for one concept, transcribed from four live schema probes rather than from
 * documentation. Enumerated rather than typed as `string` so adding a model means choosing from a
 * reviewed set, and so a typo is a compile error rather than a provider rejection.
 *
 * - `image` — `alibaba/hh1.1-i2v`.
 * - `first_frame_image` — `minimax/hailuo-2.3`, which frames the picture as the clip's first frame.
 * - `image_uri` — `lightricks/ltx-2-5-fast`.
 * - `image_input` — `runwayml/gen-4.5`.
 */
export type SourceImageParameterName = 'image' | 'first_frame_image' | 'image_uri' | 'image_input';

/**
 * How a reviewed model will accept the visitor's picture.
 *
 * The decisive question for this panel, and the one that decides whether a model can be offered at
 * all. Every reviewed model types its image parameter as a URI, so raw bytes are never an option;
 * what differs is whether a `data:` URI counts.
 *
 * - `data-uri` — the model accepts an inline `data:` URI, so the picture travels in the request and
 *   is never stored. This is the only value a model in this panel may currently declare.
 * - `https-only` — the model requires a fetchable HTTPS URL, which would mean publishing the
 *   visitor's picture at a URL a third party can retrieve. Declared so the refusal is a documented
 *   capability rather than an undocumented omission; see the panel's contract review.
 */
export type SourceImageDelivery = 'data-uri' | 'https-only';

/**
 * A numeric control a model exposes, with the range the server will accept.
 *
 * Structurally identical to Create Video's range, and deliberately declared separately rather than
 * imported: the two panels publish independent catalogues, and a shared type would imply the two
 * control sets move together when they do not.
 */
export interface AnimateNumericRange {
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
 * Which controls one image-to-video model supports, and what it charges.
 *
 * Every field is explicit rather than inferred, because the reviewed models disagree about all of
 * it: they name the source image four different ways, enumerate resolutions that share no value
 * (`720P` against `768P`), accept a continuous duration range against exactly two fixed lengths,
 * and — most awkwardly — **price in two incompatible shapes**. A field absent here is never
 * forwarded.
 */
export interface AnimateImageControlSupport {
  /**
   * The wire name of the source-image parameter; see {@link SourceImageParameterName}.
   */
  imageParameterName: SourceImageParameterName;
  /**
   * How the model will accept the picture; see {@link SourceImageDelivery}.
   *
   * Verified live against each provider's validator rather than taken from documentation. A model
   * declaring `https-only` cannot be offered by this panel without publishing the visitor's
   * picture, so the field exists to make that refusal explicit.
   */
  imageDelivery: SourceImageDelivery;
  /**
   * Whether the model requires a motion prompt rather than treating it as optional.
   *
   * The reviewed models disagree: Alibaba animates a picture with no prompt at all, while MiniMax
   * rejects a request without one. The panel marks the field required or optional from this, so a
   * visitor is never asked for something the model ignores or allowed to omit something it
   * demands.
   */
  motionPromptRequired: boolean;
  /**
   * Accepted resolution values, exactly as the model spells them.
   *
   * Spelling matters: `720P`, `768P`, and `720p` are three different strings to a provider
   * validating against an enum, and the two reviewed models here share no resolution value at all.
   */
  resolutions: readonly string[];
  /**
   * Resolution used when the caller does not choose one.
   *
   * Deliberately the cheapest reviewed option rather than the model's own default. This panel can
   * bill several dollars for one click, and a default that quietly selected the most expensive
   * setting would be a cost trap rather than a demonstration.
   */
  defaultResolution: string;
  /**
   * Accepted duration range in seconds, for a model taking any integer in a range.
   *
   * Mutually exclusive with {@link AnimateImageControlSupport.durationChoices}: a model either
   * accepts a range or a fixed set, and declaring both would leave validation with two answers.
   */
  durationRange?: AnimateNumericRange;
  /**
   * The only durations a model accepts, in seconds, for a model declaring a fixed set.
   */
  durationChoices?: readonly number[];
  /**
   * Duration used when the caller does not choose one, in seconds.
   */
  defaultDuration: number;
  /**
   * Whether the model accepts a seed for reproducible output.
   */
  seed: boolean;
  /**
   * Whether the model accepts text describing what to avoid.
   */
  negativePrompt: boolean;
  /**
   * Price per second of output, in US dollars, keyed by the resolution values above.
   *
   * Present only for a model whose published prices actually reduce to a per-second rate. Mutually
   * exclusive with {@link AnimateImageControlSupport.priceByCombinationUsd}.
   */
  pricePerSecondUsd?: Readonly<Record<string, number>>;
  /**
   * Price in US dollars for one exact resolution-and-duration combination, keyed ``
   * `${resolution}@${duration}` ``.
   *
   * **This exists because one reviewed model's published prices genuinely do not reduce to a rate,
   * and inventing one would have been a lie with a decimal point in it.** MiniMax publishes $0.28
   * for six seconds at 768P and $0.56 for ten — 4.67¢ and 5.6¢ a second respectively — so there is
   * no single per-second figure to quote. A combination the provider has not published is **absent
   * rather than interpolated**, and the panel reports an unpriced combination as unknown.
   */
  priceByCombinationUsd?: Readonly<Record<string, number>>;
  /**
   * Exact HTTPS hosts the model's video URL may come from.
   *
   * An allowlist, because the returned URL is fetched server-side and a model that could name any
   * host would make this Worker a general-purpose fetcher. The hosts are taken from each model's
   * published examples; a provider that starts serving from a new CDN host will be refused with a
   * `502`, and the rejected host is logged so the list can be corrected from the log rather than by
   * guesswork.
   */
  outputHosts: readonly string[];
}

/**
 * Every control name an Animate Image request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const ANIMATE_CONTROL_NAMES = [
  'motionPrompt',
  'negativePrompt',
  'resolution',
  'duration',
  'seed'
] as const;

/**
 * One optional Animate Image control; see {@link ANIMATE_CONTROL_NAMES}.
 */
export type AnimateControlName = (typeof ANIMATE_CONTROL_NAMES)[number];

/**
 * Builds the price-table key for one resolution and duration.
 *
 * Exported so the browser's estimate and the server's estimate read the same table with the same
 * key. Two spellings of one key would be two different prices for one run, and the browser's would
 * be the one the visitor saw.
 *
 * @param resolution Resolution exactly as the model spells it.
 * @param duration Duration in whole seconds.
 * @returns The lookup key for {@link AnimateImageControlSupport.priceByCombinationUsd}.
 */
export function priceCombinationKey(resolution: string, duration: number): string {
  return `${resolution}@${duration}`;
}

/**
 * What the browser posts to start animating a picture.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body carrying one rather than ignoring
 * it.
 *
 * The control names here are this demo's own, not any provider's. The per-model wire names live in
 * the descriptor, so a visitor's picture becomes `image`, `first_frame_image`, `image_uri`, or
 * `image_input` depending on which model was selected without the browser needing to know any of
 * those spellings.
 */
export interface AnimateImageRequest {
  /**
   * Base64 source picture, whose format, dimensions, and size the server re-verifies from the bytes
   * themselves rather than from anything the browser declared.
   */
  imageBase64: string;
  /**
   * Reviewed model identifier, which must be registered against the `animate-image` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the job. It is also one half of the job's derived identifier, which is what makes a job
   * readable by its creator and nobody else.
   */
  runId: string;
  /**
   * Description of what should happen in the clip. Required for a model that declares
   * {@link AnimateImageControlSupport.motionPromptRequired}.
   */
  motionPrompt?: string;
  /**
   * Text describing elements to avoid. Only accepted by a model that declares support.
   */
  negativePrompt?: string;
  /**
   * Requested resolution, which must be one of the model's declared values.
   */
  resolution?: string;
  /**
   * Requested duration in seconds, within the model's declared range or set.
   */
  duration?: number;
  /**
   * Seed for reproducible output, for a model that accepts one.
   */
  seed?: number;
}

/**
 * The settings one animation was produced with.
 *
 * Echoed back rather than assumed, so the UI can state what produced a result even after the form
 * has moved on, and so the estimate shown before the request can be compared against what was
 * actually applied.
 */
export interface AppliedAnimateImageControls {
  /**
   * Model identifier that produced the video.
   */
  model: string;
  /**
   * Resolution applied, including a filled-in default.
   */
  resolution: string;
  /**
   * Duration applied in seconds, including a filled-in default.
   */
  duration: number;
  /**
   * Facts verified from the source picture's own bytes before inference.
   *
   * Carried into the result so the side-by-side layout can state what was actually animated — its
   * real format and dimensions — rather than repeating what the browser claimed about a file.
   */
  source: VerifiedImageFacts;
  /**
   * Motion prompt as sent, after trimming, when one was supplied.
   */
  motionPrompt?: string;
  /**
   * Negative prompt, when the model supported one and the caller supplied it.
   */
  negativePrompt?: string;
  /**
   * Seed applied, when the model accepts one and the caller supplied it.
   */
  seed?: number;
  /**
   * Estimated cost in US dollars, from the model's published prices.
   *
   * An estimate and labelled as one wherever it is shown. The authoritative figure is the AI
   * Gateway log's, which arrives with the run's metrics; this exists so a visitor knows the order
   * of magnitude _before_ spending it.
   */
  estimatedCostUsd: number;
  /**
   * Whether the model published a price for this exact combination.
   *
   * `false` means {@link AppliedAnimateImageControls.estimatedCostUsd} is `0` because the price is
   * **unknown**, not because the run is free. The UI reads this rather than inferring from a zero,
   * since "no charge" and "no published price" are opposite claims and a bare `$0.00` makes the
   * wrong one.
   */
  estimateKnown: boolean;
}

/**
 * What the Animate Image endpoint returns when a job has been accepted.
 *
 * A `202` rather than a `200`: the request succeeded, the work has not. The browser polls the
 * status route from here.
 */
export interface AnimateImageAcceptedResponse {
  /**
   * The run identifier the job is addressed by, echoing the request's.
   */
  runId: string;
  /**
   * State the job is in at the moment it was accepted.
   */
  state: MediaJobState;
  /**
   * The controls the server actually applied, including defaults and the cost estimate.
   */
  applied: AppliedAnimateImageControls;
}

/**
 * What the status route reports for one job.
 */
export interface AnimateImageStatusResponse {
  /**
   * The run identifier this status describes.
   */
  runId: string;
  /**
   * Current state; see `MediaJobState` in `./create-video.ts`.
   */
  state: MediaJobState;
  /**
   * The stored video, present only once the job has completed.
   */
  video?: StoredVideo;
  /**
   * The run receipt, present once the job reached a terminal state and a receipt exists.
   */
  receipt?: RunReceipt;
  /**
   * The controls the job was run with, so a job polled in a fresh tab can still describe itself.
   */
  applied?: AppliedAnimateImageControls;
  /**
   * Why the job failed. Present only in the `failed` state.
   *
   * A classification rather than a message, so the panel can present a billing failure differently
   * from a provider failure — the first needs an account topped up and the second needs another
   * attempt. A provider's own error text never reaches this field.
   */
  reason?: VideoFailureReason;
}
