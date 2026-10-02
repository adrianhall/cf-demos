import { defineStore } from 'pinia';
import type { ClassificationControlSupport } from '../../shared/classify-image';
import type { VisionControlSupport } from '../../shared/describe-image';
import type { ImageControlSupport } from '../../shared/images';
import type { RemixImageControlSupport } from '../../shared/remix-image';
import type { TaskId } from '../../shared/tasks';

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
