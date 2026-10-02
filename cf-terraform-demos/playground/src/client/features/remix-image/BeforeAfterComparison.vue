<script setup lang="ts">
/**
 * Accessible source/result comparison with a keyboard range enhancement and two-image fallback.
 */
import { computed, shallowRef } from 'vue';
import type { GeneratedImage } from '../../../images';
import type { PreparedImage } from '../describe-image/image-input';

const props = defineProps<{
  /**
   * Original source image.
   */
  source: PreparedImage;
  /**
   * Current remixed image.
   */
  result: GeneratedImage;
  /**
   * Safe download filename.
   */
  fileName: string;
}>();
const position = shallowRef(50);
const showingResult = shallowRef(true);
const resultUri = computed(() => `data:${props.result.mediaType};base64,${props.result.base64}`);
</script>

<template>
  <section class="comparison" aria-labelledby="comparison-heading">
    <h2 id="comparison-heading" class="heading">Source and result</h2>
    <div class="slider-comparison" :style="{ '--result-clip': `${position}%` }">
      <img :src="props.source.previewUri" alt="Source image" class="comparison-image" />
      <div class="result-layer" aria-hidden="true">
        <img :src="resultUri" alt="" class="comparison-image" />
      </div>
    </div>
    <label class="field-label" for="comparison-position"> Reveal result: {{ position }}% </label>
    <input
      id="comparison-position"
      v-model.number="position"
      type="range"
      min="0"
      max="100"
      class="range"
    />
    <p class="hint">
      Use the arrow keys to compare the result with the original. The images are also available
      separately below.
    </p>
    <div class="fallback" aria-label="Separate source and result images">
      <figure>
        <img :src="props.source.previewUri" alt="Source image" />
        <figcaption>Source image</figcaption>
      </figure>
      <figure v-show="showingResult">
        <img :src="resultUri" alt="Remixed result" />
        <figcaption>Remixed result</figcaption>
      </figure>
    </div>
    <button
      type="button"
      class="toggle"
      :aria-pressed="showingResult"
      @click="showingResult = !showingResult"
    >
      {{ showingResult ? 'Hide separate result' : 'Show separate result' }}
    </button>
    <p class="file">
      <a :href="resultUri" :download="props.fileName"
        >File · {{ props.result.mediaType }} ·
        {{ props.result.byteLength.toLocaleString() }} bytes</a
      >
    </p>
  </section>
</template>

<style scoped>
.heading {
  font-size: 1.125rem;
  margin: 0 0 0.75rem;
}
.slider-comparison {
  aspect-ratio: 1 / 1;
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 0.75rem;
  overflow: hidden;
  position: relative;
}
.comparison-image {
  display: block;
  height: 100%;
  object-fit: contain;
  width: 100%;
}
.result-layer {
  clip-path: inset(0 calc(100% - var(--result-clip)) 0 0);
  inset: 0;
  position: absolute;
}
.field-label {
  display: block;
  margin-top: 0.75rem;
}
.range {
  min-height: 2.5rem;
  width: 100%;
}
.hint,
.file {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
}
.fallback {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 1rem;
}
.fallback figure {
  margin: 0;
  min-width: 0;
}
.fallback img {
  border-radius: 0.5rem;
  display: block;
  max-width: 100%;
}
.fallback figcaption {
  font-size: 0.8125rem;
  margin-top: 0.25rem;
}
.toggle {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.35rem;
  color: inherit;
  cursor: pointer;
  margin-top: 0.5rem;
  min-height: 2.5rem;
  padding: 0.25rem 0.6rem;
}
.toggle:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
@media (max-width: 36rem) {
  .fallback {
    grid-template-columns: 1fr;
  }
}
</style>
