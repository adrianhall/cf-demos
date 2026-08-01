<script setup lang="ts">
import { computed } from "vue";
import { type CatalogModelId, MODEL_CATALOG } from "../../models";

/** Properties supplied to the model and parameter selector. */
interface Props {
  /** Currently selected catalog model. */
  modelId: CatalogModelId;
  /** Current sampling temperature, already clamped to the selected model's bounds. */
  temperature: number;
  /** Current output token limit, already clamped to the selected model's bounds. */
  maxTokens: number;
}

/** Events emitted when the user changes the model or a parameter. */
interface Emits {
  "update:modelId": [id: CatalogModelId];
  "update:temperature": [value: number];
  "update:maxTokens": [value: number];
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

/** The full descriptor for the currently selected model, used to derive control bounds. */
const descriptor = computed(
  () =>
    MODEL_CATALOG.find((entry) => entry.id === props.modelId) ??
    MODEL_CATALOG[0],
);

/** Label shown per catalog option: display name, provider, and whether it reasons. */
function optionLabel(entry: (typeof MODEL_CATALOG)[number]): string {
  const reasoningLabel =
    entry.reasoning === "none" ? "non-reasoning" : "reasoning";
  return `${entry.displayName} — ${entry.provider} (${reasoningLabel})`;
}

/** Forward the native `<select>`'s value as a catalog model ID. */
function onModelChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as CatalogModelId;
  emit("update:modelId", value);
}

/** Forward the temperature range input's value as a number. */
function onTemperatureChange(event: Event): void {
  emit("update:temperature", Number((event.target as HTMLInputElement).value));
}

/** Forward the max-tokens range input's value as a number. */
function onMaxTokensChange(event: Event): void {
  emit("update:maxTokens", Number((event.target as HTMLInputElement).value));
}
</script>

<template>
  <fieldset class="model-selector">
    <legend>Model and parameters</legend>

    <div class="field">
      <label for="model-select">Model</label>
      <select id="model-select" :value="modelId" @change="onModelChange">
        <option v-for="entry in MODEL_CATALOG" :key="entry.id" :value="entry.id">
          {{ optionLabel(entry) }}
        </option>
      </select>
    </div>

    <div class="field">
      <label for="temperature-range">
        Temperature
        <output for="temperature-range">{{ temperature.toFixed(2) }}</output>
      </label>
      <input
        id="temperature-range"
        :max="descriptor.temperature.max"
        :min="descriptor.temperature.min"
        :aria-valuetext="`${temperature.toFixed(2)} of ${descriptor.temperature.min} to ${descriptor.temperature.max}`"
        step="0.1"
        type="range"
        :value="temperature"
        @input="onTemperatureChange"
      />
    </div>

    <div class="field">
      <label for="max-tokens-range">
        Max output tokens
        <output for="max-tokens-range">{{ maxTokens }}</output>
      </label>
      <input
        id="max-tokens-range"
        :max="descriptor.maxOutputTokens.max"
        min="1"
        :aria-valuetext="`${maxTokens} of 1 to ${descriptor.maxOutputTokens.max}`"
        step="1"
        type="range"
        :value="maxTokens"
        @input="onMaxTokensChange"
      />
    </div>
  </fieldset>
</template>

<style scoped>
.model-selector {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
}

.model-selector legend {
  color: rgb(var(--v-theme-primary));
  font-size: 0.8125rem;
  font-weight: 700;
  padding: 0 0.25rem;
  text-transform: uppercase;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.field label {
  align-items: baseline;
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  font-size: 0.875rem;
  font-weight: 600;
  gap: 0.5rem;
  justify-content: space-between;
}

.field label output {
  color: rgb(var(--v-theme-on-surface-variant));
  font-weight: 400;
}

.field select {
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.9375rem;
  min-height: 2.75rem;
  padding: 0.5rem;
}

.field input[type="range"] {
  accent-color: rgb(var(--v-theme-primary));
  min-height: 2.75rem;
  width: 100%;
}
</style>
