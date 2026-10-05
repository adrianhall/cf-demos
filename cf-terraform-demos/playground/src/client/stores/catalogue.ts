import { defineStore } from 'pinia';
import type { AnimateImageControlSupport } from '../../shared/animate-image';
import type { ClassificationControlSupport } from '../../shared/classify-image';
import type { TextClassificationControlSupport } from '../../shared/classify-text';
import type { VideoControlSupport } from '../../shared/create-video';
import type { VisionControlSupport } from '../../shared/describe-image';
import type { DetectionControlSupport } from '../../shared/detect-objects';
import type { EvaluationControlSupport } from '../../shared/evaluate-choices';
import type { MusicControlSupport } from '../../shared/generate-music';
import type { ImageControlSupport } from '../../shared/images';
import type { SpeechControlSupport } from '../../shared/read-text';
import type { RemixImageControlSupport } from '../../shared/remix-image';
import type { SemanticSearchControlSupport } from '../../shared/semantic-search';
import type { TaskId } from '../../shared/tasks';
import type { TranscriptionControlSupport } from '../../shared/transcribe-audio';
import type { TranslationControlSupport } from '../../shared/translate-text';

/**
 * A reviewed model as the catalogue endpoint reports it.
 *
 * Declared here rather than imported from `src/worker/domain/models.ts` on purpose. Model
 * descriptors live in the Worker's domain tier and reach the browser only over HTTP; importing the
 * Worker's module into client code would invert the tier dependency and let the browser believe it
 * knows what the server accepts. This is the wire shape, and it is deliberately a subset — the
 * fields the UI actually renders.
 */
export interface CatalogueModel {
  /**
   * Model identifier, sent back as the `model` field of a task request.
   */
  id: string;
  /**
   * Human-facing name for the selector.
   */
  name: string;
  /**
   * Whether Cloudflare or a third party runs the model.
   */
  provider: string;
  /**
   * Panel this descriptor belongs to.
   */
  task: TaskId;
  /**
   * Billing unit label, used so a figure reads honestly rather than implying all costs are
   * comparable.
   */
  pricingUnit: string;
  /**
   * Link to the model's catalog page.
   */
  documentationUrl: string;
  /**
   * Context window in tokens, when the model declares one.
   */
  contextWindowTokens?: number;
  /**
   * Which optional controls an image model accepts, and within what ranges.
   *
   * Present only for a text-to-image model. The UI renders exactly the controls named here, so a
   * model that does not expose a negative prompt or a seed simply has no such field — rather than a
   * disabled one, or worse, an enabled one whose value the API then refuses.
   */
  imageControls?: ImageControlSupport;
  /**
   * Which optional controls a vision model accepts, and whether it requires a question.
   *
   * Present only for an image-to-text model. The UI reads `instructionRequired` to decide whether
   * the question field is mandatory, which is the clearest case yet of the server telling the
   * browser what it will accept rather than the browser assuming.
   */
  visionControls?: VisionControlSupport;
  /**
   * Optional controls for a reviewed image-to-image model.
   */
  remixImageControls?: RemixImageControlSupport;
  /**
   * Result controls for a reviewed image-classification model.
   *
   * Present only for a classifier. `appliedBy` is the field the UI reads to describe the controls
   * honestly: the reviewed model takes no ranking parameters, so the panel says the filtering
   * happens after the model answers rather than letting a slider imply the model was asked.
   */
  classificationControls?: ClassificationControlSupport;
  /**
   * Controls a text-to-video model accepts, how it spells them, and what it charges per second.
   *
   * Carries the price list as well as the control ranges, because this is the only panel that must
   * quote a cost _before_ the request rather than only report one afterwards: generation bills per
   * second of output at rates that differ thirtyfold across resolutions.
   */
  videoControls?: VideoControlSupport;
  /**
   * Controls an image-to-video model accepts, how it spells them, and how it prices.
   *
   * The browser needs this for two things nothing earlier required. `motionPromptRequired` decides
   * whether the prompt field is marked required, because one reviewed model animates a picture with
   * no prompt and the other refuses without one. And the pricing is **two mutually exclusive
   * shapes** rather than one rate: a per-second model's estimate moves smoothly as the duration
   * changes, while a per-combination model's jumps between the exact figures its provider published
   * — and a combination it has not published has no estimate at all, which the panel says rather
   * than showing a misleading `$0.00`.
   */
  animateImageControls?: AnimateImageControlSupport;
  /**
   * Controls a music model accepts, how it spells them, and how it bills.
   *
   * The browser needs this for something no earlier panel required: `pricing` is a **discriminated
   * union**, and which branch it carries decides what the panel can honestly quote before a run.
   * For a per-second model the estimate moves as the visitor drags the length control; for a
   * per-track model the figure is the same whatever the length, and a second charge appears if the
   * model is asked to write the lyrics. The panel renders two genuinely different cost sentences
   * from this field rather than one sentence with a different number in it.
   *
   * `lengthSeconds` is likewise absent rather than zero for a model with no length control, which
   * is why the length slider exists for one model and cannot exist for the other.
   */
  musicControls?: MusicControlSupport;
  /**
   * Controls an object-detection model accepts, and the two absences that shape the panel.
   *
   * `maxObjects` is the demo's first genuinely **provider-applied** result limit: the model honours
   * it, so the panel forwards the number rather than trimming a longer list afterwards as Classify
   * Image does. The field the browser needs most, though, is the one declared `false`:
   * `scoreFloor`. Moondream returns four coordinates per box and nothing else — no label, no
   * confidence — so there is no score to filter on, and a panel that rendered a confidence control
   * would be offering a setting that could not do anything. Carrying the absence explicitly is what
   * lets the UI say so instead of quietly omitting a control the visitor might go looking for.
   */
  detectionControls?: DetectionControlSupport;
  /**
   * Controls a text-to-speech model accepts, how it spells them, and what it charges per character.
   *
   * The clearest case in the demo of the server telling the browser what it will accept rather than
   * the browser assuming: the reviewed speech models share no controls at all, so the panel renders
   * a voice selector or a language selector depending on which fields this object carries — never
   * both, and never one the provider would reject.
   */
  speechControls?: SpeechControlSupport;
  /**
   * Controls a transcription model accepts, how it carries audio, and what it charges per minute.
   *
   * The browser needs this for something no earlier panel required: the _file size limit_ is
   * per-model, because the encoding a model's schema demands decides what is safe to send. The
   * picker therefore reads its own ceiling from here rather than from a shared constant, so a file
   * is refused in the browser with the same number the server would use.
   */
  transcriptionControls?: TranscriptionControlSupport;
  /**
   * Which languages a translation model accepts, and whether it batches its lines.
   *
   * The browser needs this for two things no earlier panel required. The **swap action** exists
   * only for a model that declares a source language, so the control is rendered from this rather
   * than always present and sometimes inert. And `batchesSegments` lets the panel predict how many
   * paid calls a passage will make _before_ the request, which is the one cost-shaped figure this
   * panel can quote in advance.
   */
  translationControls?: TranslationControlSupport;
  /**
   * What a text classifier can emit, and whether it scores anything.
   *
   * The browser needs this for three things. `outcomeKind` decides **which renderer to use at all**
   * — a verdict model has no scores, so a confidence bar would show `NaN%` against a perfectly
   * valid answer. `labelSet` lets the panel publish the complete, closed set of possible answers
   * _before_ any run, which is the clearest way to show what a fixed-label classifier is. And the
   * ranking controls are rendered only where they exist, rather than always present and sometimes
   * inert.
   */
  textClassificationControls?: TextClassificationControlSupport;
  /**
   * What a search model does, and what a repeat search against it will cost.
   *
   * The browser needs this for something no earlier panel required. `strategy` and `cacheable`
   * decide what the panel can honestly promise _before_ a run: searching the same collection again
   * is free for an embedding model and charged in full for a cross-encoder, and that is the
   * trade-off the panel exists to teach. `dimensions` is published before any run because it is the
   * clearest evidence that two models' scores are not comparable.
   */
  semanticSearchControls?: SemanticSearchControlSupport;
  /**
   * What a decision model accepts, and what it charges for.
   *
   * The browser needs `supportedQuestionTypes` so the question builder offers only types the
   * selected model answers — an unsupported type should be unconstructible rather than rejected
   * after a visitor has written it. `contextWindowTokens` drives the View Tokens handoff: the panel
   * counts the state's tokens in the browser and shows how much of the window it occupies.
   */
  evaluationControls?: EvaluationControlSupport;
}

/**
 * A documented gateway exception as the catalogue endpoint reports it.
 *
 * Declared here for the same reason as {@link CatalogueModel}: the authoritative register is the one
 * the Worker enforces, and it reaches the browser over HTTP. Importing the Worker's domain module
 * would invert the tier dependency, and a browser-side copy could be stale in exactly the situation
 * that matters.
 */
export interface CatalogueException {
  /**
   * Stable exception identifier.
   */
  id: string;
  /**
   * Panel the exception affects.
   */
  panel: string;
  /**
   * The technical reason gateway routing is impossible for this operation.
   */
  reason: string;
  /**
   * What the person using the panel sees instead.
   */
  userFacingBehaviour: string;
}

/**
 * The reviewed model list, fetched from `/api/catalogue`.
 *
 * The server is the authority on which models it will accept, so the selector is built from its
 * answer rather than from a client-side copy that could offer a model the API then rejects.
 *
 * It is a store rather than a per-component fetch so several panels can share one response: the
 * catalogue is identical for every panel and does not change within a session.
 */
export const useCatalogueStore = defineStore('catalogue', {
  actions: {
    /**
     * Fetches the catalogue once per session.
     *
     * @returns A promise fulfilled once the models are available or the attempt has failed. A
     *   failure is recorded in `error` rather than thrown, because a panel can still render its
     *   explanatory content without a model list.
     */
    async load(): Promise<void> {
      if (this.loaded || this.loading) {
        return;
      }

      this.loading = true;
      this.error = null;
      try {
        const response = await fetch('/api/catalogue');
        if (!response.ok) {
          throw new Error('The model catalogue could not be loaded.');
        }
        const body = (await response.json()) as { models: CatalogueModel[] };
        this.models = body.models;
        this.loaded = true;
      } catch (cause) {
        this.error =
          cause instanceof Error ? cause.message : 'The model catalogue could not be loaded.';
      } finally {
        this.loading = false;
      }
    }
  },
  getters: {
    /**
     * Lists the reviewed models for one panel, in catalogue order.
     *
     * @param state Current store state.
     * @returns A function taking a task identifier and returning its models; empty when the
     *   catalogue has not loaded or the panel has no reviewed model.
     */
    modelsForTask:
      (state) =>
      (task: TaskId): CatalogueModel[] =>
        state.models.filter((model) => model.task === task)
  },
  state: (): {
    models: CatalogueModel[];
    loading: boolean;
    loaded: boolean;
    error: string | null;
  } => ({
    /**
     * Every reviewed model the server reported.
     */
    models: [],
    /**
     * Whether a catalogue request is in flight.
     */
    loading: false,
    /**
     * Whether the catalogue has been loaded successfully, so it is fetched once per session.
     */
    loaded: false,
    /**
     * Message from a failed catalogue request, or `null`.
     */
    error: null
  })
});
