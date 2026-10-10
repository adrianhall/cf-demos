import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import { defineStore } from "pinia";
import { computed, shallowRef } from "vue";
import {
  type CatalogModelId,
  DEFAULT_MODEL_ID,
  findModel,
  type ModelDescriptor,
} from "../../models";

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Selected model and generation parameters for the **next** turn the user submits, kept in
 * memory only per docs/05-AI-CHAT.md — this demo persists nothing across a page reload, matching
 * the stateless-Worker/browser-held-conversation design.
 *
 * Temperature and max-token bounds come from the **selected model's own descriptor**, not one
 * shared range (see `src/models.ts` and docs/05-AI-CHAT.md's Llama 4 Scout correction). Switching
 * models re-clamps the current values into the new descriptor's bounds rather than resetting
 * them to that model's defaults, so a deliberate parameter choice survives a model switch unless
 * it is genuinely out of range for the new model.
 */
export const useSettingsStore = defineStore("settings", () => {
  const initialDescriptor = findModel(DEFAULT_MODEL_ID);
  // MODEL_CATALOG is `as const` and DEFAULT_MODEL_ID is typed against its own id union, so this
  // can only fail if the two are edited out of sync with each other.
  throwIfNull(
    initialDescriptor,
    "DEFAULT_MODEL_ID must name a MODEL_CATALOG entry.",
  );

  const modelId = shallowRef<CatalogModelId>(DEFAULT_MODEL_ID);
  const temperature = shallowRef(initialDescriptor.temperature.default);
  const maxTokens = shallowRef(initialDescriptor.maxOutputTokens.default);

  /** The full descriptor for {@link modelId}, re-derived whenever the selection changes. */
  const descriptor = computed<ModelDescriptor>(() => {
    const found = findModel(modelId.value);
    // `modelId` only ever changes through `selectModel()`, which already rejects an ID absent
    // from the catalog, so `found` can only be null here if that invariant is broken elsewhere.
    throwIfNull(found, `${modelId.value} is not a MODEL_CATALOG entry.`);
    return found;
  });

  /**
   * Select a different catalog model, re-clamping the current temperature and max-token values
   * into that model's bounds so neither control is left showing an out-of-range value (see
   * docs/05-AI-CHAT.md, Phase 4, task 19).
   *
   * @param id Catalog model identifier to select.
   */
  function selectModel(id: CatalogModelId): void {
    const next = findModel(id);
    if (!next) {
      return;
    }
    modelId.value = id;
    temperature.value = clamp(
      temperature.value,
      next.temperature.min,
      next.temperature.max,
    );
    maxTokens.value = clamp(maxTokens.value, 1, next.maxOutputTokens.max);
  }

  /** Set the sampling temperature, clamped to the selected model's bounds. */
  function setTemperature(value: number): void {
    temperature.value = clamp(
      value,
      descriptor.value.temperature.min,
      descriptor.value.temperature.max,
    );
  }

  /** Set the output token limit, clamped to the selected model's bounds. */
  function setMaxTokens(value: number): void {
    maxTokens.value = clamp(value, 1, descriptor.value.maxOutputTokens.max);
  }

  return {
    descriptor,
    maxTokens,
    modelId,
    selectModel,
    setMaxTokens,
    setTemperature,
    temperature,
  };
});
