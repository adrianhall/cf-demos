<script setup lang="ts">
import {
  downloadFileName,
  downloadLabel,
  formatBytes,
  imageAltText,
  toDataUri,
  type GalleryEntry
} from './gallery';

defineProps<{
  /**
   * Generated results, newest first.
   */
  entries: GalleryEntry[];
}>();

const emit = defineEmits<{
  /**
   * Visitor wants to use this server-verified result as a Remix Image source.
   */
  remix: [entry: GalleryEntry];
  /**
   * Visitor wants to animate this server-verified result in Animate Image.
   *
   * A second handoff rather than a generalised "send this somewhere" event, because the two
   * destinations are different panels doing different things and a single event with a target
   * parameter would push the choice of destination into the parent anyway.
   */
  animate: [entry: GalleryEntry];
}>();
</script>

<template>
  <section v-if="entries.length > 0" class="gallery" aria-labelledby="gallery-heading">
    <h2 id="gallery-heading" class="section-heading">Results</h2>
    <ol class="results">
      <li v-for="entry in entries" :key="entry.runId" class="result">
        <!--
          The alt text names the prompt the image was generated from rather than asserting what the
          picture contains: nothing here has looked at the image, and a diffusion model frequently
          does not produce what was asked for. Claiming otherwise would be a confident lie to the
          one user who cannot check it.
        -->
        <img
          class="result-image"
          :src="toDataUri(entry.image)"
          :alt="imageAltText(entry)"
          :width="entry.applied.width"
          :height="entry.applied.height"
        />

        <div class="result-body">
          <p class="result-prompt">{{ entry.applied.prompt }}</p>
          <p v-if="entry.applied.negativePrompt" class="result-negative">
            Avoiding: {{ entry.applied.negativePrompt }}
          </p>

          <!--
            The settings are listed per result, which is what makes the gallery a comparison tool
            rather than a scrapbook: two images of the same prompt at different step counts are only
            informative if you can see which was which.
          -->
          <dl class="result-settings">
            <div class="setting">
              <dt>Model</dt>
              <dd>{{ entry.modelName }}</dd>
            </div>
            <div v-if="entry.applied.steps !== undefined" class="setting">
              <dt>Steps</dt>
              <dd>{{ entry.applied.steps }}</dd>
            </div>
            <div v-if="entry.applied.width !== undefined" class="setting">
              <dt>Size</dt>
              <dd>{{ entry.applied.width }} × {{ entry.applied.height }}</dd>
            </div>
            <div v-if="entry.applied.guidance !== undefined" class="setting">
              <dt>Guidance</dt>
              <dd>{{ entry.applied.guidance }}</dd>
            </div>
            <div v-if="entry.applied.seed !== undefined" class="setting">
              <dt>Seed</dt>
              <dd>{{ entry.applied.seed }}</dd>
            </div>
            <div class="setting">
              <dt>File</dt>
              <dd>
                <!--
                  The file facts themselves are the download link, so the card has one compact
                  action instead of repeating the format in a separate "Download JPEG" row. The
                  extension follows the server's byte-level sniff, keeping the saved name aligned
                  with the actual contents rather than with anything the provider declared.
                -->
                <a
                  class="file-download"
                  :href="toDataUri(entry.image)"
                  :download="downloadFileName(entry)"
                  :aria-label="downloadLabel(entry)"
                >
                  {{ entry.image.mediaType.replace('image/', '').toUpperCase() }},
                  {{ formatBytes(entry.image.byteLength) }}
                </a>
              </dd>
            </div>
          </dl>
          <!--
            Two secondary actions rather than one, and both stay secondary: the generated image is
            the result, and these are things a visitor may go on to do with it. "Animate this
            image" is the Create Image → Animate Image handoff the specification calls the single
            most memorable sequence in this application, which is why it sits beside Remix rather
            than being buried in a menu — but it does not displace the image itself.
          -->
          <div class="handoff-actions">
            <button type="button" class="remix-action" @click="emit('remix', entry)">
              Remix this image
            </button>
            <button type="button" class="remix-action" @click="emit('animate', entry)">
              Animate this image
            </button>
          </div>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.gallery {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.section-heading {
  font-size: 1.125rem;
  margin: 0;
}

.results {
  display: grid;
  gap: 1.25rem;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  list-style: none;
  margin: 0;
  padding: 0;
}

.result {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.75rem;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/*
  `height: auto` alongside the intrinsic width/height attributes, so the browser can reserve the
  right space before the image paints without the attributes forcing a fixed display size.
*/
.result-image {
  aspect-ratio: 1 / 1;
  background-color: rgb(var(--v-theme-surface-variant));
  display: block;
  height: auto;
  object-fit: contain;
  width: 100%;
}

.result-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.875rem 1rem 1rem;
}

.result-prompt {
  margin: 0;
}

.result-negative {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
}

.result-settings {
  display: grid;
  gap: 0.25rem 1rem;
  grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
  margin: 0;
}

.setting dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
}

.setting dd {
  font-size: 0.875rem;
  margin: 0;
}

/*
  The metadata remains visually a value in the settings list while the underline and colour make
  its download action explicit. Padding extends the clickable area beyond the text without adding
  another row or button-shaped box to the card.
*/
.file-download {
  color: rgb(var(--v-theme-primary));
  display: inline-block;
  min-height: 1.5rem;
  padding-block: 0.125rem;
  text-underline-offset: 0.125rem;
}

.file-download:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.handoff-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.remix-action {
  align-self: flex-start;
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.35rem;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  min-height: 2.5rem;
  padding: 0.35rem 0.7rem;
}

.remix-action:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
</style>
