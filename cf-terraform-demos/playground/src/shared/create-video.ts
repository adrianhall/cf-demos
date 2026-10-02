/**
 * @file The Create Video panel's wire contract. It sits in `src/shared/` beside the other panels'
 *   contracts because both tiers need it, and like them it carries no model descriptors — the
 *   browser learns which models exist and which controls each accepts from `/api/catalogue`. Two
 *   things make this contract different from every panel before it, and both come from the reviewed
 *   model contracts rather than from a design preference. **The result is a job, not a value.**
 *   Every earlier panel answers its own request: the model returns within the request and the
 *   response carries the result. A video takes minutes, and the visitor's connection is the fragile
 *   part — an HTTP Worker has no duration limit while the client stays connected, but when the tab
 *   closes the request is cancelled and `waitUntil()` buys about thirty seconds. A render abandoned
 *   halfway is a render that was _paid for_ and discarded, so generation is handed to a Workflow
 *   and this contract describes a job to poll rather than a result to read. **The video is stored,
 *   and the panel says so.** Every reviewed text-to-video model returns a short-lived URL on the
 *   provider's own host rather than bytes. Rendering that URL directly would make the panel's
 *   primary result depend on an external host's retention, leak the visitor's IP to it, and break
 *   when a run is reopened from history. The bytes are therefore copied once into this demo's R2
 *   bucket and served from an authenticated route — which is also what lets `<video>` seek, since a
 *   `Range` request cannot be answered by base64 in a JSON body. There is deliberately **no expiry
 *   field here**: until the scheduled reaper arrives in phase 18 nothing deletes a stored object,
 *   and a countdown this demo could not honour would be worse than none.
 */

import type { RunReceipt } from './runs.ts';

/**
 * Longest prompt the panel accepts, in characters.
 *
 * Set to the tightest of the reviewed models' documented limits rather than to each model's own, so
 * the editor's counter means the same thing whichever model is selected. PixVerse caps at 2048 and
 * Alibaba at 2500; the lower bound governs. The server still validates per request — a browser
 * limit is a courtesy, never a control.
 */
export const MAX_VIDEO_PROMPT_CHARACTERS = 2_048;

/**
 * Largest generated video this demo will copy out of a provider and into storage, in bytes.
 *
 * Bounds the fetch-and-store step rather than a JSON response: the bytes are streamed into R2 and
 * never buffered whole, so this is a storage and egress bound rather than a memory one. Fifteen
 * seconds of 1080p sits comfortably inside it, and a provider answering with something far larger
 * than its own contract implies is refused rather than stored.
 */
export const MAX_VIDEO_BYTES = 128 * 1_024 * 1_024;

/**
 * Media types the panel will play.
 *
 * An allowlist, and for the same reason the image panels keep one: the type decides how a browser
 * treats the bytes. The stored object's type is established by inspecting its leading bytes, never
 * by trusting the provider's `Content-Type`, so a provider cannot choose how its response is
 * interpreted by this demo's own origin.
 */
export const PLAYABLE_VIDEO_MEDIA_TYPES = ['video/mp4', 'video/webm'] as const;

/**
 * One media type the panel will play; see {@link PLAYABLE_VIDEO_MEDIA_TYPES}.
 */
export type VideoMediaType = (typeof PLAYABLE_VIDEO_MEDIA_TYPES)[number];

/**
 * Reports whether a value is a media type this panel plays.
 *
 * @param value Candidate media type, sniffed from provider bytes.
 * @returns `true` when the type is in the allowlist.
 */
export function isPlayableVideoMediaType(value: string): value is VideoMediaType {
  return (PLAYABLE_VIDEO_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * File extension to offer when downloading each media type.
 *
 * Derived from the sniffed type rather than from anything the provider declared, so a download's
 * name cannot disagree with its actual bytes.
 */
export const VIDEO_FILE_EXTENSIONS: Readonly<Record<VideoMediaType, string>> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm'
};

/**
 * Lifecycle of one video generation, as the browser sees it.
 *
 * Task-neutral by design: Animate Image in phase 9 reuses these states rather than inventing its
 * own, and no provider vocabulary appears here. The reviewed models have no job API at all — their
 * only documented envelope state is `Completed` — so these states describe _this demo's_ Workflow,
 * which is the only thing that actually has a lifecycle to report.
 *
 * - `accepted` — the job exists and has not started running yet.
 * - `running` — the model is generating, or the result is being copied into storage.
 * - `completed` — the video is stored and playable.
 * - `failed` — generation or storage failed; `error` explains it in terms a visitor can act on.
 * - `cancelled` — the visitor stopped it, and anything already stored has been deleted.
 */
export type MediaJobState = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * States from which a job can no longer change.
 *
 * Exported so the browser's polling loop and the server's state mapping share one definition of
 * "finished" — a poll that continued past a terminal state would be a loop with no exit condition.
 */
export const TERMINAL_MEDIA_JOB_STATES: readonly MediaJobState[] = [
  'completed',
  'failed',
  'cancelled'
];

/**
 * Reports whether a job state can still change.
 *
 * @param state The state to test.
 * @returns `true` when no further transition is possible.
 */
export function isTerminalMediaJobState(state: MediaJobState): boolean {
  return TERMINAL_MEDIA_JOB_STATES.includes(state);
}

/**
 * A numeric control a model exposes, with the range the server will accept.
 *
 * Published per model through the catalogue so the UI renders a control with correct bounds and the
 * server validates against the same numbers. One definition means a control cannot offer a value
 * the API then rejects.
 */
export interface VideoNumericRange {
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
 * Which controls one video model supports, and what it charges.
 *
 * Every field is explicit rather than inferred, because the reviewed models disagree about all of
 * it: one names its quality control `quality` with lowercase `720p` values while another names it
 * `resolution` with uppercase `720P`, one takes any integer duration in a range while another
 * accepts only three specific lengths, and only some generate audio. A field absent here is never
 * forwarded.
 */
export interface VideoControlSupport {
  /**
   * The wire name of the resolution control, which differs between reviewed models.
   */
  resolutionParameterName: 'quality' | 'resolution';
  /**
   * Accepted resolution values, exactly as the model spells them. Spelling matters: `720p` and
   * `720P` are different strings to a provider validating against an enum.
   */
  resolutions: readonly string[];
  /**
   * Resolution used when the caller does not choose one.
   *
   * Deliberately the cheapest reviewed option rather than the model's own default. This panel can
   * bill several dollars for one click, and a default that quietly selects the most expensive
   * setting would be a cost trap rather than a demonstration.
   */
  defaultResolution: string;
  /**
   * The wire name of the aspect-ratio control.
   */
  aspectParameterName: 'aspect_ratio' | 'ratio';
  /**
   * Accepted aspect-ratio values, exactly as the model spells them.
   */
  aspectRatios: readonly string[];
  /**
   * Aspect ratio used when the caller does not choose one.
   */
  defaultAspectRatio: string;
  /**
   * Accepted duration range in seconds, for a model taking any integer in a range.
   *
   * Mutually exclusive with {@link VideoControlSupport.durationChoices}: a model either accepts a
   * range or a fixed set, and declaring both would leave validation with two answers.
   */
  durationRange?: VideoNumericRange;
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
   * The wire name of the audio control, when the model can generate audio. Absent for a model that
   * only produces silent video.
   */
  audioParameterName?: 'generate_audio' | 'audio';
  /**
   * Price per second of output, in US dollars, keyed by the resolution values above.
   *
   * Present so the panel can show an _estimate before the request_, which matters here in a way it
   * did not for any earlier panel: pricing is per second and spans thirtyfold across resolutions,
   * so the same prompt can cost thirteen cents or four dollars. The figure shown after a run always
   * comes from the AI Gateway log — this is only ever labelled as an estimate.
   */
  pricePerSecondUsd: Readonly<Record<string, number>>;
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
 * Every control name a Create Video request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const VIDEO_CONTROL_NAMES = [
  'negativePrompt',
  'resolution',
  'aspectRatio',
  'duration',
  'seed',
  'generateAudio'
] as const;

/**
 * One optional Create Video control; see {@link VIDEO_CONTROL_NAMES}.
 */
export type VideoControlName = (typeof VIDEO_CONTROL_NAMES)[number];

/**
 * What the browser posts to start generating a video.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body carrying one rather than ignoring
 * it.
 *
 * The control names here are this demo's own, not any provider's. The per-model wire names live in
 * the descriptor, so a visitor's `resolution` becomes `quality` or `resolution` depending on which
 * model was selected without the browser needing to know either spelling.
 */
export interface CreateVideoRequest {
  /**
   * Description of the video to generate.
   */
  prompt: string;
  /**
   * Reviewed model identifier, which must be registered against the `create-video` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the job. It is also one half of the job's derived identifier, which is what makes a job
   * readable by its creator and nobody else.
   */
  runId: string;
  /**
   * Text describing elements to avoid. Only accepted by a model that declares support.
   */
  negativePrompt?: string;
  /**
   * Requested resolution, which must be one of the model's declared values.
   */
  resolution?: string;
  /**
   * Requested aspect ratio, which must be one of the model's declared values.
   */
  aspectRatio?: string;
  /**
   * Requested duration in seconds, within the model's declared range or set.
   */
  duration?: number;
  /**
   * Seed for reproducible output, for a model that accepts one.
   */
  seed?: number;
  /**
   * Whether to generate audio, for a model that can.
   */
  generateAudio?: boolean;
}

/**
 * The settings one video was generated with.
 *
 * Echoed back rather than assumed, so the UI can state what produced a result even after the form
 * has moved on, and so the estimate shown before the request can be compared against what was
 * actually applied.
 */
export interface AppliedVideoControls {
  /**
   * Prompt as sent, after trimming.
   */
  prompt: string;
  /**
   * Model identifier that generated the video.
   */
  model: string;
  /**
   * Resolution applied, including a filled-in default.
   */
  resolution: string;
  /**
   * Aspect ratio applied, including a filled-in default.
   */
  aspectRatio: string;
  /**
   * Duration applied in seconds, including a filled-in default.
   */
  duration: number;
  /**
   * Negative prompt, when the model supported one and the caller supplied it.
   */
  negativePrompt?: string;
  /**
   * Seed applied, when the model accepts one and the caller supplied it.
   */
  seed?: number;
  /**
   * Whether audio was requested, when the model can generate it.
   */
  generateAudio?: boolean;
  /**
   * Estimated cost in US dollars, from the model's published per-second price.
   *
   * An estimate and labelled as one wherever it is shown. The authoritative figure is the AI
   * Gateway log's, which arrives with the run's metrics; this exists so a visitor knows the order
   * of magnitude _before_ spending it.
   */
  estimatedCostUsd: number;
}

/**
 * The stored video a completed job produced.
 *
 * Carries no bytes and no provider URL. The browser plays the video from this demo's own
 * authenticated route, which is what makes seeking work and what keeps the provider's host out of
 * the page.
 */
export interface StoredVideo {
  /**
   * Media type established by inspecting the stored bytes.
   */
  mediaType: VideoMediaType;
  /**
   * Size of the stored video in bytes, so the UI can state it without fetching the video.
   */
  byteLength: number;
}

/**
 * What the Create Video endpoint returns when a job has been accepted.
 *
 * A `202` rather than a `200`: the request succeeded, the work has not. The browser polls the
 * status route from here.
 */
export interface CreateVideoAcceptedResponse {
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
  applied: AppliedVideoControls;
}

/**
 * What the status route reports for one job.
 */
export interface CreateVideoStatusResponse {
  /**
   * The run identifier this status describes.
   */
  runId: string;
  /**
   * Current state; see {@link MediaJobState}.
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
  applied?: AppliedVideoControls;
  /**
   * Why the job failed, in terms a visitor can act on. Present only in the `failed` state, and
   * never carrying a provider's raw error text.
   */
  error?: string;
}
